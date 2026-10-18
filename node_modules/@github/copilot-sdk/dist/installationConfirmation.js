import {
  CancellationTokenSource,
  ResponseError
} from "vscode-jsonrpc/node.js";
function createInstallationConfirmationAdapter(connection, handler) {
  const closed = new CancellationTokenSource();
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
      const combined = new CancellationTokenSource();
      const subscriptions = [];
      const cancelRequest = () => combined.cancel();
      const cancelConnection = () => combined.cancel();
      const checkCancellation = () => {
        if (closed.token.isCancellationRequested) {
          throw new Error("Installation confirmation connection closed");
        }
        if (token.isCancellationRequested) {
          throw new ResponseError(-32800, "Installation confirmation request cancelled");
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
                new ResponseError(
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
export {
  createInstallationConfirmationAdapter
};
