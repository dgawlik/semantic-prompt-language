#!/usr/bin/env node
// Zero-dependency JSON-RPC 2.0 Language Server for SPL (.splx) over stdio
import { SplLanguageService } from "./lsp-service.js";

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export function startLspServer(): void {
  const service = new SplLanguageService();
  let buffer: Uint8Array = Buffer.from("");
  let shutdownRequested = false;

  const send = (msg: RpcMessage): void => {
    const json = JSON.stringify(msg);
    const bytes = Buffer.byteLength(json, "utf8");
    process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
  };

  const publishDiagnostics = (uri: string): void => {
    const { diagnostics } = service.analyze(uri);
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics },
    });
  };

  const handleMessage = (msg: RpcMessage): void => {
    const { id, method, params } = msg;

    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          capabilities: {
            textDocumentSync: 1, // Full document sync
            completionProvider: {
              triggerCharacters: [".", "?", "\"", "(", ","],
              resolveProvider: false,
            },
            signatureHelpProvider: {
              triggerCharacters: ["(", ","],
            },
            hoverProvider: true,
            definitionProvider: true,
            documentSymbolProvider: true,
          },
          serverInfo: {
            name: "splx-language-server",
            version: "0.1.0",
          },
        },
      });
      return;
    }

    if (method === "initialized") return;

    if (method === "shutdown") {
      shutdownRequested = true;
      send({ jsonrpc: "2.0", id, result: null });
      return;
    }

    if (method === "exit") {
      process.exit(shutdownRequested ? 0 : 1);
    }

    if (method === "textDocument/didOpen" && params) {
      const td = params.textDocument as { uri: string; text: string };
      service.setDocument(td.uri, td.text);
      publishDiagnostics(td.uri);
      return;
    }

    if (method === "textDocument/didChange" && params) {
      const td = params.textDocument as { uri: string };
      const changes = params.contentChanges as { text: string }[];
      if (changes && changes.length > 0) {
        service.setDocument(td.uri, changes[changes.length - 1].text);
        publishDiagnostics(td.uri);
      }
      return;
    }

    if (method === "textDocument/didSave" && params) {
      const td = params.textDocument as { uri: string };
      publishDiagnostics(td.uri);
      return;
    }

    if (method === "textDocument/didClose" && params) {
      const td = params.textDocument as { uri: string };
      service.closeDocument(td.uri);
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: td.uri, diagnostics: [] },
      });
      return;
    }

    if (method === "textDocument/completion" && params) {
      const td = params.textDocument as { uri: string };
      const position = params.position as { line: number; character: number };
      const items = service.getCompletions(td.uri, position);
      send({ jsonrpc: "2.0", id, result: { isIncomplete: false, items } });
      return;
    }

    if (method === "textDocument/signatureHelp" && params) {
      const td = params.textDocument as { uri: string };
      const position = params.position as { line: number; character: number };
      const sig = service.getSignatureHelp(td.uri, position);
      send({ jsonrpc: "2.0", id, result: sig });
      return;
    }

    if (method === "textDocument/hover" && params) {
      const td = params.textDocument as { uri: string };
      const position = params.position as { line: number; character: number };
      const hover = service.getHover(td.uri, position);
      send({ jsonrpc: "2.0", id, result: hover });
      return;
    }

    if (method === "textDocument/definition" && params) {
      const td = params.textDocument as { uri: string };
      const position = params.position as { line: number; character: number };
      const loc = service.getDefinition(td.uri, position);
      send({ jsonrpc: "2.0", id, result: loc });
      return;
    }

    if (method === "textDocument/documentSymbol" && params) {
      const td = params.textDocument as { uri: string };
      const symbols = service.getDocumentSymbols(td.uri);
      send({ jsonrpc: "2.0", id, result: symbols });
      return;
    }

    // Respond cleanly to unknown requests (with id)
    if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  };

  process.stdin.on("data", (chunk: Uint8Array) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const buf = Buffer.from(buffer);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = buf.toString("ascii", 0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buf.subarray(headerEnd + 4);
        continue;
      }
      const contentLength = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buf.length < bodyStart + contentLength) break;

      const body = buf.toString("utf8", bodyStart, bodyStart + contentLength);
      buffer = buf.subarray(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body) as RpcMessage;
        handleMessage(msg);
      } catch {
        // Ignore malformed JSON frames
      }
    }
  });

  process.stdin.resume();
}

// Launch directly when invoked as a standalone script
const invokedAsLsp = process.argv[1]?.replace(/\\/g, "/").endsWith("/lsp.js");
if (invokedAsLsp) {
  startLspServer();
}
