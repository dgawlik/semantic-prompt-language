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
var installationConfirmation_exports = {};
__export(installationConfirmation_exports, {
  createInstallationConfirmationAdapter: () => createInstallationConfirmationAdapter
});
module.exports = __toCommonJS(installationConfirmation_exports);
var import_node = require("vscode-jsonrpc/node.js");
function createInstallationConfirmationAdapter(connection, handler) {
  const closed = new import_node.CancellationTokenSource();
  const closeSubscription = connection.onClose(() => closed.cancel());
  const disposeSubscription = connection.onDispose(() => {
    closed.cancel();
    closed.dispose();
    closeSubscription.dispose();
    disposeSubscription.dispose();
  });
  return {
    async confirm(request, token) {
      if (!token) {
        throw new Error("Installation confirmation request cancellation is unavailable");
      }
      const { confirmationId, reviewFingerprint } = request;
      const combined = new import_node.CancellationTokenSource();
      const subscriptions = [];
      const cancelRequest = () => combined.cancel();
      const cancelConnection = () => combined.cancel();
      const checkCancellation = () => {
        if (closed.token.isCancellationRequested) {
          throw new Error("Installation confirmation connection closed");
        }
        if (token.isCancellationRequested) {
          throw new import_node.ResponseError(-32800, "Installation confirmation request cancelled");
        }
      };
      try {
        subscriptions.push(
          token.onCancellationRequested(cancelRequest),
          closed.token.onCancellationRequested(cancelConnection)
        );
        if (token.isCancellationRequested || closed.token.isCancellationRequested) {
          combined.cancel();
        }
        checkCancellation();
        const cancelled = new Promise((_resolve, reject) => {
          subscriptions.push(
            token.onCancellationRequested(
              () => reject(
                new import_node.ResponseError(
                  -32800,
                  "Installation confirmation request cancelled"
                )
              )
            ),
            closed.token.onCancellationRequested(
              () => reject(new Error("Installation confirmation connection closed"))
            )
          );
        });
        const decision = await Promise.race([
          Promise.resolve().then(() => {
            checkCancellation();
            return handler(request, combined.token);
          }),
          cancelled
        ]);
        checkCancellation();
        if (decision !== "confirm" && decision !== "decline" && decision !== "cancel") {
          throw new Error("Invalid installation confirmation decision");
        }
        return { confirmationId, reviewFingerprint, decision };
      } finally {
        for (const subscription of subscriptions) subscription.dispose();
        combined.dispose();
      }
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createInstallationConfirmationAdapter
});
