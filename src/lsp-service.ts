import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSpecToSource, isStdlibPath, normalizeFsPath } from "./compiler.js";
import { SplLanguageServiceCore, type SplLanguageHost } from "./lsp-core.js";

export {
  SplLanguageServiceCore,
  type SplLanguageHost,
  type LspPosition,
  type LspRange,
  type LspLocation,
  type LspDiagnostic,
  type LspCompletionItem,
  type LspParameterInformation,
  type LspSignatureInformation,
  type LspSignatureHelp,
  type LspHover,
  type LspDocumentSymbol,
} from "./lsp-core.js";

export function uriToFsPath(uri: string): string {
  if (uri.startsWith("file://")) return fileURLToPath(uri);
  return path.resolve(uri);
}

const nodeLanguageHost: SplLanguageHost = {
  uriToPath: uriToFsPath,
  pathToUri: (filePath: string) => pathToFileURL(path.resolve(filePath)).href,
  normalizePath: normalizeFsPath,
  isStdlibPath,
  resolveModuleSpec: resolveSpecToSource,
  readFile: (filePath: string) => (fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined),
};

export class SplLanguageService extends SplLanguageServiceCore {
  constructor() {
    super(nodeLanguageHost);
  }
}
