#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const vscodeExtDir = path.join(repoRoot, "editors", "vscode");
const extPkg = JSON.parse(fs.readFileSync(path.join(vscodeExtDir, "package.json"), "utf8"));

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const install = args.includes("--install");
const outFlagIdx = args.indexOf("--out");
const defaultVsixName = `${extPkg.name}-${extPkg.version}.vsix`;
const outPath = outFlagIdx !== -1 && args[outFlagIdx + 1]
  ? path.resolve(args[outFlagIdx + 1])
  : path.join(vscodeExtDir, defaultVsixName);

function copyFiltered(srcDir, destDir, predicate) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyFiltered(src, dest, predicate);
    } else if (entry.isFile() && predicate(entry.name)) {
      fs.copyFileSync(src, dest);
    }
  }
}

// 1. Build SPL compiler & LSP server
if (!skipBuild) {
  console.log("Building SPL compiler & LSP server...");
  execSync("npm run build", { cwd: repoRoot, stdio: "inherit" });
}

const distLsp = path.join(repoRoot, "dist", "lsp.js");
if (!fs.existsSync(distLsp)) {
  throw new Error(`Expected built LSP server at ${distLsp}. Run 'npm run build' first.`);
}

// 2. Ensure VS Code extension dependencies (including @vscode/vsce) are installed
const vsceBin = path.join(
  vscodeExtDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vsce.cmd" : "vsce"
);
if (!fs.existsSync(path.join(vscodeExtDir, "node_modules")) || !fs.existsSync(vsceBin)) {
  console.log("Installing VS Code extension dependencies...");
  execSync("npm install", { cwd: vscodeExtDir, stdio: "inherit" });
}

// 3. Stage self-contained server bundle inside editors/vscode/server/
const stageDir = path.join(vscodeExtDir, "server");
fs.rmSync(stageDir, { recursive: true, force: true });

try {
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(
    path.join(stageDir, "package.json"),
    JSON.stringify({ name: "splx-bundled-server", private: true, type: "module" }, null, 2) + "\n",
    "utf8"
  );
  copyFiltered(path.join(repoRoot, "dist"), path.join(stageDir, "dist"), (name) => name.endsWith(".js"));
  copyFiltered(path.join(repoRoot, "stdlib"), path.join(stageDir, "stdlib"), (name) => name.endsWith(".splx"));
  copyFiltered(path.join(repoRoot, "runtime"), path.join(stageDir, "runtime"), (name) => name.endsWith(".mjs"));

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // 4. Package .vsix with vsce
  console.log(`Packaging ${path.relative(repoRoot, outPath)}...`);
  const vsceArgs = [
    "package",
    "--skip-license",
    "--allow-missing-repository",
    "--out",
    outPath,
  ];
  if (process.platform === "win32") {
    execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", vsceBin, ...vsceArgs], {
      cwd: vscodeExtDir,
      stdio: "inherit",
    });
  } else {
    execFileSync(vsceBin, vsceArgs, {
      cwd: vscodeExtDir,
      stdio: "inherit",
    });
  }
} finally {
  // Always remove staged server copy so dev-linked installs keep using repo dist/
  fs.rmSync(stageDir, { recursive: true, force: true });
}

const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(1);
console.log(`\nPackaged VSIX: ${outPath} (${sizeKb} KB)`);

if (install) {
  console.log("Installing VSIX into VS Code...");
  if (process.platform === "win32") {
    execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "code", "--install-extension", outPath, "--force"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } else {
    execFileSync("code", ["--install-extension", outPath, "--force"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
  console.log("Reload VS Code (Ctrl+Shift+P -> 'Developer: Reload Window') to activate.");
}
