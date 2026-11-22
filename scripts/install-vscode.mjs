#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const vscodeExtSrc = path.join(repoRoot, "editors", "vscode");
const extPkg = JSON.parse(fs.readFileSync(path.join(vscodeExtSrc, "package.json"), "utf8"));
const extId = `${extPkg.publisher}.${extPkg.name}-${extPkg.version}`;

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const skipBuild = args.includes("--skip-build");
const targetFlagIdx = args.indexOf("--target");
const customTarget = targetFlagIdx !== -1 ? args[targetFlagIdx + 1] : undefined;

const extensionsDir = customTarget
  ? path.resolve(customTarget)
  : path.join(os.homedir(), ".vscode", "extensions");
const destPath = path.join(extensionsDir, extId);

if (uninstall) {
  if (fs.existsSync(destPath)) {
    fs.rmSync(destPath, { recursive: true, force: true });
    console.log(`Uninstalled ${extId} from ${destPath}`);
  } else {
    console.log(`${extId} is not installed at ${destPath}`);
  }
  process.exit(0);
}

// 1. Ensure compiler & LSP server are built
if (!skipBuild) {
  console.log("Building SPL compiler & LSP server...");
  execSync("npm run build", { cwd: repoRoot, stdio: "inherit" });
}

// 2. Ensure VS Code extension dependencies are installed
if (!fs.existsSync(path.join(vscodeExtSrc, "node_modules"))) {
  console.log("Installing VS Code extension dependencies...");
  execSync("npm install", { cwd: vscodeExtSrc, stdio: "inherit" });
}

// 3. Link editors/vscode into VS Code extensions directory
fs.mkdirSync(extensionsDir, { recursive: true });

// Remove any previous version of spl-lang.splx-vscode-*
for (const entry of fs.readdirSync(extensionsDir)) {
  if (entry.startsWith(`${extPkg.publisher}.${extPkg.name}-`) || entry === extPkg.name) {
    const oldPath = path.join(extensionsDir, entry);
    fs.rmSync(oldPath, { recursive: true, force: true });
  }
}

const linkType = process.platform === "win32" ? "junction" : "dir";
fs.symlinkSync(vscodeExtSrc, destPath, linkType);

console.log(`Installed ${extId}`);
console.log(`  Link:   ${destPath} -> ${vscodeExtSrc}`);
console.log(`  Server: ${path.join(repoRoot, "dist", "lsp.js")}`);
console.log("Reload VS Code (Ctrl+Shift+P -> 'Developer: Reload Window') to activate .splx support.");
