import { CopilotClient } from "./client.js";
import {
  defaultJoinSessionPermissionHandler
} from "./types.js";
import {
  Canvas,
  CanvasError,
  createCanvas
} from "./canvas.js";
import {
  defineWorkflow,
  WorkflowResumeError,
  isWorkflowRunTerminal
} from "./workflow.js";
async function joinSession(config = {}) {
  const sessionId = process.env.SESSION_ID;
  if (!sessionId) {
    throw new Error(
      "joinSession() is intended for extensions running as child processes of the Copilot CLI."
    );
  }
  const client = new CopilotClient({ _internalConnection: { kind: "parent-process" } });
  const {
    extensionSdkPath: _stripped,
    skillProvider: _strippedSkillProvider,
    imageGeneration: _strippedImageGeneration,
    workflows,
    requestedEnvironmentVariables,
    ...rest
  } = config;
  void _stripped;
  void _strippedSkillProvider;
  void _strippedImageGeneration;
  return client.resumeSessionForExtension(
    sessionId,
    {
      ...rest,
      onPermissionRequest: config.onPermissionRequest ?? defaultJoinSessionPermissionHandler,
      suppressResumeEvent: config.suppressResumeEvent ?? true
    },
    { workflows },
    requestedEnvironmentVariables?.length ? { requestedEnvironmentVariables } : void 0
  );
}
export {
  Canvas,
  CanvasError,
  WorkflowResumeError,
  createCanvas,
  defineWorkflow,
  isWorkflowRunTerminal,
  joinSession
};
