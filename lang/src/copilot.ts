/** Compatibility import for embedding hosts; execution now uses the AI SDK. */
export { AiBackend as CopilotBackend, type AiBackendOptions as CopilotBackendOptions } from './ai.js';

import { Failure } from './errors.js';
import { configuredMcpTool, type McpServers } from './mcp.js';
import type { Restrictions } from './restrict.js';
import { TOOL_SPECS, type ToolName } from './tools.js';

type PermissionRequest =
    | { kind: 'mcp'; serverName: string; toolName: string; readOnly?: boolean; toolTitle?: string }
    | { kind: 'custom-tool'; toolName: string }
    | { kind: 'read'; path: string }
    | { kind: 'write'; fileName: string }
    | { kind: 'url'; url: string }
    | { kind: 'shell'; commands: { identifier: string }[]; possiblePaths: string[] };

/** Legacy permission helper. AI SDK execution exposes no native provider tools. */
export function decidePermission(
    request: PermissionRequest, restrictions: Restrictions, block: (failure: Failure) => void, servers: McpServers = {},
): { kind: 'approve-once' | 'reject'; feedback?: string } {
    try {
        if (request.kind === 'mcp') {
            restrictions.checkMcp(request.serverName, request.toolName);
            return configuredMcpTool(servers, request.serverName, request.toolName)
                ? { kind: 'approve-once' }
                : { kind: 'reject', feedback: 'MCP server/tool is not enabled by --mcp configuration.' };
        }
        if (request.kind === 'custom-tool' && Object.hasOwn(TOOL_SPECS, request.toolName as ToolName)) return { kind: 'approve-once' };
        if (request.kind === 'read') restrictions.checkPath(request.path, 'read');
        else if (request.kind === 'write') restrictions.checkPath(request.fileName, 'write');
        else if (request.kind === 'url') restrictions.checkUrl(request.url);
        else if (request.kind === 'shell') {
            for (const command of request.commands) restrictions.checkExec(command.identifier);
            for (const file of request.possiblePaths) restrictions.checkPath(file, 'read');
        }
    } catch (error) {
        if (!(error instanceof Failure)) throw error;
        block(error);
        return { kind: 'reject', feedback: JSON.stringify(error.payload()) };
    }
    return { kind: 'reject', feedback: 'Only runtime tools and configured MCP tools may be used.' };
}
