import { type CancellationToken, type MessageConnection } from "vscode-jsonrpc/node.js";
import type { InstallationConfirmationRequest, InstallationDecision, InstallationsConfirmResult } from "./generated/rpc.js";
/** The `installations.confirm` receiver, invoked with the transport's request cancellation. */
export interface InstallationConfirmationReceiver {
    confirm(request: InstallationConfirmationRequest, token: CancellationToken): Promise<InstallationsConfirmResult>;
}
/**
 * Collects an explicit human decision for the complete runtime review.
 * Match operationId and policySessionId to the exact action registered by the host
 * before displaying it. Refuse unknown actions or incomplete reviews; never infer
 * authority from the current session or a global pending slot.
 *
 * The SDK echoes the original challenge and fingerprint. Separately spawned UI
 * work must observe the token to retire itself when the request or connection ends.
 * Registering this callback does not enable installation capabilities.
 * @experimental
 */
export type InstallationConfirmationHandler = (request: InstallationConfirmationRequest, token: CancellationToken) => InstallationDecision | Promise<InstallationDecision>;
export declare function createInstallationConfirmationAdapter(connection: MessageConnection, handler: InstallationConfirmationHandler): InstallationConfirmationReceiver;
