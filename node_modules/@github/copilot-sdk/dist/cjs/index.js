"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var index_exports = {};
__export(index_exports, {
  AhpHost: () => import_host.AhpHost,
  BuiltInTools: () => import_toolSet.BuiltInTools,
  Canvas: () => import_canvas.Canvas,
  CanvasError: () => import_canvas.CanvasError,
  CopilotClient: () => import_client.CopilotClient,
  CopilotRequestHandler: () => import_types2.CopilotRequestHandler,
  CopilotSession: () => import_session.CopilotSession,
  CopilotWebSocketCloseStatus: () => import_types2.CopilotWebSocketCloseStatus,
  CopilotWebSocketForwarder: () => import_types2.CopilotWebSocketForwarder,
  CopilotWebSocketHandler: () => import_types2.CopilotWebSocketHandler,
  DisableBypassPermissionsModes: () => import_types.DisableBypassPermissionsModes,
  RuntimeConnection: () => import_types.RuntimeConnection,
  SYSTEM_MESSAGE_SECTIONS: () => import_types2.SYSTEM_MESSAGE_SECTIONS,
  SessionFsSqliteTransactionFailure: () => import_types2.SessionFsSqliteTransactionFailure,
  SessionFsWriteFailure: () => import_types2.SessionFsWriteFailure,
  ToolSet: () => import_toolSet.ToolSet,
  WorkflowResumeError: () => import_workflow.WorkflowResumeError,
  approveAll: () => import_types2.approveAll,
  convertMcpCallToolResult: () => import_types2.convertMcpCallToolResult,
  createAttributedPermissionResult: () => import_types2.createAttributedPermissionResult,
  createCanvas: () => import_canvas.createCanvas,
  createSessionFsAdapter: () => import_types2.createSessionFsAdapter,
  defineTool: () => import_types2.defineTool,
  defineWorkflow: () => import_workflow.defineWorkflow,
  isWorkflowRunTerminal: () => import_workflow.isWorkflowRunTerminal
});
module.exports = __toCommonJS(index_exports);
var import_client = require("./client.js");
var import_host = require("./host.js");
var import_types = require("./types.js");
var import_toolSet = require("./toolSet.js");
var import_session = require("./session.js");
var import_workflow = require("./workflow.js");
var import_canvas = require("./canvas.js");
var import_types2 = require("./types.js");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AhpHost,
  BuiltInTools,
  Canvas,
  CanvasError,
  CopilotClient,
  CopilotRequestHandler,
  CopilotSession,
  CopilotWebSocketCloseStatus,
  CopilotWebSocketForwarder,
  CopilotWebSocketHandler,
  DisableBypassPermissionsModes,
  RuntimeConnection,
  SYSTEM_MESSAGE_SECTIONS,
  SessionFsSqliteTransactionFailure,
  SessionFsWriteFailure,
  ToolSet,
  WorkflowResumeError,
  approveAll,
  convertMcpCallToolResult,
  createAttributedPermissionResult,
  createCanvas,
  createSessionFsAdapter,
  defineTool,
  defineWorkflow,
  isWorkflowRunTerminal
});
