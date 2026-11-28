#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const extDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf8"));
const folderName = `${pkg.publisher}.${pkg.name}-${pkg.version}`;
const prefix = `${pkg.publisher}.${pkg.name}-`;

const FILES_TO_COPY = [
  "package.json",
  "README.md",
  "language-configuration.json",
  "splb-language-configuration.json",
  "syntaxes",
];

const EDITOR_DIRS = {
  vscode: path.join(os.homedir(), ".vscode", "extensions"),
  insiders: path.join(os.homedir(), ".vscode-insiders", "extensions"),
  cursor: path.join(os.homedir(), ".cursor", "extensions"),
  antigravity: path.join(os.homedir(), ".antigravity", "extensions"),
  windsurf: path.join(os.homedir(), ".windsurf", "extensions"),
};

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall") || args.includes("-u");
const editorIdx = args.indexOf("--editor");
const editorArg = editorIdx !== -1 ? args[editorIdx + 1] : "auto";

function resolveTargets() {
  if (editorArg === "all") {
    return Object.entries(EDITOR_DIRS);
  }
  if (editorArg && editorArg !== "auto") {
    const dir = EDITOR_DIRS[editorArg];
    if (!dir) {
      console.error(`Unknown editor '${editorArg}'. Expected one of: auto, all, ${Object.keys(EDITOR_DIRS).join(", ")}`);
      process.exit(1);
    }
    return [[editorArg, dir]];
  }
  // Auto-detect existing editor extension folders; fall back to ~/.vscode/extensions
  const found = Object.entries(EDITOR_DIRS).filter(([, dir]) => fs.existsSync(path.dirname(dir)));
  return found.length > 0 ? found : [["vscode", EDITOR_DIRS.vscode]];
}

function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

for (const [name, baseDir] of resolveTargets()) {
  if (uninstall) {
    if (!fs.existsSync(baseDir)) continue;
    let removed = 0;
    for (const entry of fs.readdirSync(baseDir)) {
      if (entry.startsWith(prefix)) {
        fs.rmSync(path.join(baseDir, entry), { recursive: true, force: true });
        console.log(`Removed ${name}: ${path.join(baseDir, entry)}`);
        removed++;
      }
    }
    if (removed === 0) console.log(`Not installed in ${name} (${baseDir})`);
    continue;
  }

  fs.mkdirSync(baseDir, { recursive: true });
  // Remove older versions of the same extension
  for (const entry of fs.readdirSync(baseDir)) {
    if (entry.startsWith(prefix)) {
      fs.rmSync(path.join(baseDir, entry), { recursive: true, force: true });
    }
  }

  const target = path.join(baseDir, folderName);
  fs.mkdirSync(target, { recursive: true });
  for (const item of FILES_TO_COPY) {
    const src = path.join(extDir, item);
    if (fs.existsSync(src)) {
      copyRecursive(src, path.join(target, item));
    }
  }
  console.log(`Installed ${folderName} -> ${target} (${name})`);
}

if (!uninstall) {
  console.log("\nReload your editor window (Ctrl+Shift+P -> Developer: Reload Window) to activate syntax highlighting for .spl and .splb files.");
}
