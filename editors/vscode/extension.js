"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

let client = null;
let startPromise = null;

function resolveServerPath(context) {
  const cfg = vscode.workspace.getConfiguration("splx");
  const configured = cfg.get("serverPath");
  if (configured && fs.existsSync(configured)) {
    return configured;
  }

  // 1. Prefer an SPL compiler checkout in the currently open workspace
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    const candidate = path.join(folder.uri.fsPath, "dist", "lsp.js");
    const stdlibDir = path.join(folder.uri.fsPath, "stdlib");
    if (fs.existsSync(candidate) && fs.existsSync(stdlibDir)) {
      return candidate;
    }
  }

  // 2. Check relative to real extension path (works when dev-linked into ~/.vscode/extensions)
  const realExtPath = fs.existsSync(context.extensionPath)
    ? fs.realpathSync(context.extensionPath)
    : context.extensionPath;
  const repoLocal = path.resolve(realExtPath, "..", "..", "dist", "lsp.js");
  if (fs.existsSync(repoLocal)) {
    return repoLocal;
  }

  // 3. Check bundled server packaged inside the .vsix
  const bundled = path.join(realExtPath, "server", "dist", "lsp.js");
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  return bundled;
}

function createAndStartClient(context, outputChannel, fileWatcher) {
  const cfg = vscode.workspace.getConfiguration("splx");
  const nodePath = cfg.get("nodePath") || "node";
  const serverModule = resolveServerPath(context);

  if (!fs.existsSync(serverModule)) {
    throw new Error(
      `SPL Language Server not found at '${serverModule}'. Run 'npm run build' in the SPL repo, reinstall the .vsix, or configure 'splx.serverPath'.`
    );
  }

  const serverOptions = {
    run: {
      command: nodePath,
      args: [serverModule],
      transport: TransportKind.stdio,
    },
    debug: {
      command: nodePath,
      args: [serverModule],
      transport: TransportKind.stdio,
    },
  };

  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "splx" }],
    outputChannel,
    synchronize: {
      fileEvents: fileWatcher,
    },
  };

  client = new LanguageClient(
    "splxLanguageServer",
    "SPL (.splx) Language Server",
    serverOptions,
    clientOptions
  );

  startPromise = client.start();
  return startPromise;
}

async function stopCurrentClient() {
  if (startPromise) {
    try {
      await startPromise;
    } catch {
      // Ignore failed startup when stopping
    }
    startPromise = null;
  }
  if (!client) return;
  const old = client;
  client = null;
  try {
    if (typeof old.isRunning === "function" ? old.isRunning() : true) {
      await old.stop();
    }
  } catch {
    // Ignore stop errors if process already exited
  }
  try {
    if (typeof old.dispose === "function") {
      await old.dispose();
    }
  } catch {
    // Ignore dispose errors
  }
}

function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("SPL (.splx) Language Server");
  const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.splx");
  context.subscriptions.push(outputChannel, fileWatcher);

  const serverModule = resolveServerPath(context);
  try {
    createAndStartClient(context, outputChannel, fileWatcher).catch((err) => {
      outputChannel.appendLine(`[splx] Failed to start LSP: ${err && err.message ? err.message : String(err)}`);
    });
  } catch (err) {
    outputChannel.appendLine(`[splx] ${err && err.message ? err.message : String(err)}`);
  }

  let restarting = false;
  let debounceTimer = null;

  const restartServer = async () => {
    if (restarting) return;
    restarting = true;
    try {
      await stopCurrentClient();
      await createAndStartClient(context, outputChannel, fileWatcher);
    } finally {
      restarting = false;
    }
  };

  // Manual restart command: "SPL: Restart Language Server"
  context.subscriptions.push(
    vscode.commands.registerCommand("splx.restartServer", async () => {
      try {
        await restartServer();
        vscode.window.showInformationMessage("SPL Language Server restarted.");
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        outputChannel.appendLine(`[splx] Restart failed: ${msg}`);
        vscode.window.showErrorMessage(`SPL Language Server restart failed: ${msg}`);
      }
    })
  );

  // Auto-restart when `dist/*.js` is rebuilt by `npm run build`
  if (fs.existsSync(serverModule)) {
    const distDir = path.dirname(serverModule);
    try {
      const watcher = fs.watch(distDir, (_, filename) => {
        if (filename && filename.endsWith(".js")) {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            restartServer().catch((err) => {
              outputChannel.appendLine(`[splx] Auto-restart failed: ${err && err.message ? err.message : String(err)}`);
            });
          }, 500);
        }
      });
      context.subscriptions.push({
        dispose: () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          watcher.close();
        },
      });
    } catch {
      // Ignore watcher errors on unsupported filesystems
    }
  }

  context.subscriptions.push({
    dispose: () => {
      return stopCurrentClient();
    },
  });
}

function deactivate() {
  return stopCurrentClient();
}

module.exports = { activate, deactivate };
