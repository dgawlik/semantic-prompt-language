class CanvasError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "CanvasError";
  }
  code;
  /** Default error when an action is declared but no `handler` is wired. */
  static noHandler() {
    return new CanvasError(
      "canvas_action_no_handler",
      "No handler implemented for this canvas action"
    );
  }
}
class Canvas {
  declaration;
  open;
  onClose;
  /** @internal */
  actionHandlers;
  /** @internal */
  constructor(options) {
    const actionHandlers = /* @__PURE__ */ new Map();
    const wireActions = options.actions?.map(
      ({ handler, ...wire }) => {
        actionHandlers.set(wire.name, handler);
        return wire;
      }
    );
    this.declaration = {
      id: options.id,
      displayName: options.displayName,
      description: options.description,
      inputSchema: options.inputSchema,
      actions: wireActions
    };
    this.open = options.open;
    this.onClose = options.onClose;
    this.actionHandlers = actionHandlers;
  }
}
function createCanvas(options) {
  return new Canvas(options);
}
export {
  Canvas,
  CanvasError,
  createCanvas
};
