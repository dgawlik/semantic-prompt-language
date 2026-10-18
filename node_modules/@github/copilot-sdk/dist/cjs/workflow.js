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
var workflow_exports = {};
__export(workflow_exports, {
  WORKFLOW_AGENT_OPTION_KEYS: () => WORKFLOW_AGENT_OPTION_KEYS,
  WorkflowResumeError: () => WorkflowResumeError,
  defineWorkflow: () => defineWorkflow,
  getWorkflowDefinition: () => getWorkflowDefinition,
  isWorkflowRunTerminal: () => isWorkflowRunTerminal
});
module.exports = __toCommonJS(workflow_exports);
const WORKFLOW_TERMINAL_STATUSES = /* @__PURE__ */ new Set([
  "completed",
  "halted",
  "paused",
  "cancelled",
  "error"
]);
function isWorkflowRunTerminal(status) {
  return WORKFLOW_TERMINAL_STATUSES.has(status);
}
const WORKFLOW_AGENT_OPTION_KEYS = [
  "label",
  "schema",
  "model",
  "reasoningEffort",
  "contextTier",
  "agent"
];
class WorkflowResumeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "WorkflowResumeError";
  }
  code;
}
const workflowHandles = /* @__PURE__ */ new WeakMap();
const MAX_WORKFLOW_TIMEOUT_SECONDS = 2147483647e-3;
const NANO_AIU_PER_AIU = 1e9;
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}
function validateLimits(meta) {
  const limits = meta.limits;
  if (!limits) {
    return;
  }
  for (const field of ["maxConcurrentSubagents", "maxTotalSubagents"]) {
    const value = limits[field];
    if (value !== void 0 && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`Workflow limit "${field}" must be a positive integer`);
    }
  }
  if (limits.timeoutSeconds !== void 0 && (!Number.isFinite(limits.timeoutSeconds) || limits.timeoutSeconds <= 0)) {
    throw new Error(
      'Workflow limit "timeoutSeconds" must be a positive, finite number of seconds'
    );
  }
  if (limits.timeoutSeconds !== void 0 && limits.timeoutSeconds > MAX_WORKFLOW_TIMEOUT_SECONDS) {
    throw new Error(
      `Workflow limit "timeoutSeconds" must not exceed ${MAX_WORKFLOW_TIMEOUT_SECONDS} seconds`
    );
  }
  if (limits.maxAiCredits !== void 0) {
    const maxNanoAiu = Math.round(limits.maxAiCredits * NANO_AIU_PER_AIU);
    if (!Number.isFinite(limits.maxAiCredits) || limits.maxAiCredits <= 0 || !Number.isSafeInteger(maxNanoAiu) || maxNanoAiu < 1) {
      throw new Error(
        'Workflow limit "maxAiCredits" must be a positive, finite number that rounds to a safe positive integer nano-AIU ceiling'
      );
    }
  }
}
function validatePhases(meta) {
  const titles = /* @__PURE__ */ new Set();
  for (const phase of meta.phases) {
    if (phase.title.trim().length === 0) {
      throw new Error("Workflow phase titles must not be empty");
    }
    if (titles.has(phase.title)) {
      throw new Error(`Workflow phase title "${phase.title}" is declared more than once`);
    }
    titles.add(phase.title);
  }
}
function defineWorkflow(definition) {
  const meta = deepFreeze(structuredClone(definition.meta));
  validateLimits(meta);
  validatePhases(meta);
  const stored = {
    meta,
    run: definition.run
  };
  const handle = Object.freeze({ meta });
  workflowHandles.set(handle, stored);
  return handle;
}
function getWorkflowDefinition(handle) {
  const definition = workflowHandles.get(handle);
  if (!definition) {
    throw new Error("Invalid workflow handle");
  }
  return definition;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WORKFLOW_AGENT_OPTION_KEYS,
  WorkflowResumeError,
  defineWorkflow,
  getWorkflowDefinition,
  isWorkflowRunTerminal
});
