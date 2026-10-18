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
var runtimeArtifacts_exports = {};
__export(runtimeArtifacts_exports, {
  RUNTIME_PLATFORMS: () => RUNTIME_PLATFORMS,
  defaultRuntimeCacheRoot: () => defaultRuntimeCacheRoot,
  ensureRuntimeBundle: () => ensureRuntimeBundle,
  getRuntimePackageName: () => getRuntimePackageName,
  getRuntimePlatform: () => getRuntimePlatform,
  getRuntimeReleaseAssetName: () => getRuntimeReleaseAssetName,
  materializeRuntimeBundle: () => materializeRuntimeBundle,
  resolvePackageRoot: () => resolvePackageRoot,
  validateFile: () => validateFile
});
module.exports = __toCommonJS(runtimeArtifacts_exports);
var import_node_fs = require("node:fs");
var import_node_crypto = require("node:crypto");
var import_node_module = require("node:module");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_cliVersion = require("./cliVersion.js");
const import_meta = {};
const require2 = (0, import_node_module.createRequire)(typeof __filename === "string" ? __filename : import_meta.url);
const RUNTIME_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "linuxmusl-arm64",
  "linuxmusl-x64",
  "win32-arm64",
  "win32-x64"
];
const EXCLUDED_TOP_LEVEL = /* @__PURE__ */ new Set([
  "app.js",
  "assets",
  "changelog.json",
  "cli-main.js",
  "copilot",
  "copilot.exe",
  "foundry-local-sdk",
  "index.js",
  "LICENSE.md",
  "napi-oop-runtime",
  "npm-loader.js",
  "package.json",
  "pvrecorder",
  "queries",
  "README.md",
  "sea-loader.js",
  "webview"
]);
function validateFile(path, label) {
  if (!(0, import_node_fs.existsSync)(path)) {
    throw new Error(`${label} not found at ${path}.`);
  }
  if ((0, import_node_fs.statSync)(path).size === 0) {
    throw new Error(`${label} at ${path} is empty.`);
  }
}
function validateRuntimeBundle(wrapper, runtimeNode) {
  validateFile(wrapper, "Copilot runtime wrapper");
  validateFile(runtimeNode, "Copilot runtime.node");
}
function isExcluded(relativePath) {
  const parts = relativePath.split(import_node_path.sep);
  const topLevel = parts[0];
  const fileName = parts.at(-1) ?? "";
  return EXCLUDED_TOP_LEVEL.has(topLevel) || /^tree-sitter.*\.wasm$/.test(topLevel) || /^voice-.*\.js$/.test(topLevel) || fileName === "cli-native.node" || parts.includes("mediaremote-adapter") || fileName.startsWith("copilot-runtime-bin");
}
function collectRuntimeAssets(sources) {
  const assets = [];
  const visit = (directory) => {
    for (const entry of (0, import_node_fs.readdirSync)(directory, { withFileTypes: true })) {
      const source = (0, import_node_path.join)(directory, entry.name);
      const sourceRelative = (0, import_node_path.relative)(sources.packageRoot, source);
      if (isExcluded(sourceRelative)) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(source);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }
      const parts = sourceRelative.split(import_node_path.sep);
      if (parts[0] === "prebuilds") {
        if (parts[1] !== sources.platform || parts.length < 3) {
          continue;
        }
      }
      assets.push({ source, relativePath: sourceRelative });
    }
  };
  visit(sources.packageRoot);
  return assets.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
function sourceFingerprint(assets) {
  const hash = (0, import_node_crypto.createHash)("sha256");
  for (const asset of assets) {
    const stat = (0, import_node_fs.lstatSync)(asset.source);
    hash.update(asset.relativePath).update("\0");
    hash.update(`${stat.size}:${stat.mtimeMs}`).update("\0");
  }
  return hash.digest("hex").slice(0, 20);
}
function makeExecutable(path) {
  if (process.platform === "win32") {
    return;
  }
  const mode = (0, import_node_fs.statSync)(path).mode;
  if ((mode & 73) === 0) {
    (0, import_node_fs.chmodSync)(path, mode | 73);
  }
}
function defaultRuntimeCacheRoot(platform = process.platform, home = (0, import_node_os.homedir)(), environment = process.env) {
  const cacheDirectory = platform === "win32" ? environment.LOCALAPPDATA ?? (0, import_node_path.join)(home, "AppData", "Local") : platform === "darwin" ? (0, import_node_path.join)(home, "Library", "Caches") : environment.XDG_CACHE_HOME ?? (0, import_node_path.join)(home, ".cache");
  return (0, import_node_path.join)(cacheDirectory, "github-copilot-sdk", "runtime");
}
function materializeRuntimeBundle(sources, cacheRoot = defaultRuntimeCacheRoot(), cacheKey = `${sources.platform}-${sourceFingerprint(collectRuntimeAssets(sources))}`) {
  const assets = collectRuntimeAssets(sources);
  const wrapperName = sources.platform.startsWith("win32") ? "copilot-runtime.exe" : "copilot-runtime";
  const prebuildDir = (0, import_node_path.join)("prebuilds", sources.platform);
  const wrapperRelative = (0, import_node_path.join)(prebuildDir, wrapperName);
  const runtimeNodeRelative = (0, import_node_path.join)(prebuildDir, "runtime.node");
  const sourceWrapper = assets.find((asset) => asset.relativePath === wrapperRelative)?.source;
  const sourceRuntimeNode = assets.find(
    (asset) => asset.relativePath === runtimeNodeRelative
  )?.source;
  validateRuntimeBundle(sourceWrapper ?? "", sourceRuntimeNode ?? "");
  const installDir = (0, import_node_path.join)(cacheRoot, cacheKey);
  const installedWrapper = (0, import_node_path.join)(installDir, wrapperRelative);
  const installedRuntimeNode = (0, import_node_path.join)(installDir, runtimeNodeRelative);
  if ((0, import_node_fs.existsSync)(installDir)) {
    validateRuntimeBundle(installedWrapper, installedRuntimeNode);
    makeExecutable(installedWrapper);
    return installedWrapper;
  }
  (0, import_node_fs.mkdirSync)(cacheRoot, { recursive: true });
  const stagingDir = (0, import_node_fs.mkdtempSync)((0, import_node_path.join)(cacheRoot, ".runtime-"));
  try {
    for (const asset of assets) {
      const destination = (0, import_node_path.join)(stagingDir, asset.relativePath);
      (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(destination), { recursive: true });
      (0, import_node_fs.copyFileSync)(asset.source, destination);
    }
    const stagedWrapper = (0, import_node_path.join)(stagingDir, wrapperRelative);
    makeExecutable(stagedWrapper);
    (0, import_node_fs.renameSync)(stagingDir, installDir);
  } catch (error) {
    if (!(0, import_node_fs.existsSync)(installDir)) {
      throw error;
    }
    validateRuntimeBundle(installedWrapper, installedRuntimeNode);
  } finally {
    (0, import_node_fs.rmSync)(stagingDir, { recursive: true, force: true });
  }
  return installedWrapper;
}
function isMusl() {
  if (process.platform !== "linux") {
    return false;
  }
  const report = process.report?.getReport();
  return report?.header?.glibcVersionRuntime === void 0;
}
function getRuntimePlatform(platform = process.platform, arch = process.arch, musl = isMusl()) {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported Copilot CLI architecture: ${arch}.`);
  }
  if (platform === "linux") {
    return `${musl ? "linuxmusl" : "linux"}-${arch}`;
  }
  if (platform === "darwin" || platform === "win32") {
    return `${platform}-${arch}`;
  }
  throw new Error(`Unsupported Copilot CLI platform: ${platform}-${arch}.`);
}
function getRuntimeReleaseAssetName(version, platform) {
  return `github-copilot-${version}-${platform}.tgz`;
}
function getRuntimePackageName(platform) {
  return `@github/copilot-sdk-${platform}`;
}
function resolvePackageRoot(packageName, searchPaths = require2.resolve.paths(packageName) ?? []) {
  return searchPaths.map((base) => (0, import_node_path.join)(base, ...packageName.split("/"))).find((candidate) => (0, import_node_fs.existsSync)((0, import_node_path.join)(candidate, "package.json")));
}
async function ensureRuntimeBundle(version, options = {}) {
  const platform = options.platform ?? getRuntimePlatform();
  if (import_cliVersion.COPILOT_CLI_USE_NPM_PACKAGE) {
    const packageName2 = `@github/copilot-${platform}`;
    const packageRoot2 = resolvePackageRoot(packageName2, options.packageSearchPaths);
    if (!packageRoot2) {
      throw new Error(`Could not resolve ${packageName2} for Copilot CLI ${version}.`);
    }
    validateFile(
      (0, import_node_path.join)(packageRoot2, "prebuilds", platform, "runtime.node"),
      "Copilot runtime.node"
    );
    return materializeRuntimeBundle(
      { packageRoot: packageRoot2, platform },
      options.cacheRoot,
      `${version}-${platform}`
    );
  }
  const packageName = getRuntimePackageName(platform);
  const packageRoot = resolvePackageRoot(packageName, options.packageSearchPaths);
  if (!packageRoot) {
    throw new Error(
      `Could not resolve ${packageName}. Reinstall @github/copilot-sdk so its platform package is installed.`
    );
  }
  const wrapperName = platform.startsWith("win32") ? "copilot-runtime.exe" : "copilot-runtime";
  const prebuildDir = (0, import_node_path.join)(packageRoot, "prebuilds", platform);
  const wrapper = (0, import_node_path.join)(prebuildDir, wrapperName);
  try {
    validateRuntimeBundle(wrapper, (0, import_node_path.join)(prebuildDir, "runtime.node"));
  } catch (error) {
    throw new Error(
      `${packageName} is missing required Copilot CLI runtime files. Reinstall @github/copilot-sdk.`,
      { cause: error }
    );
  }
  makeExecutable(wrapper);
  return wrapper;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RUNTIME_PLATFORMS,
  defaultRuntimeCacheRoot,
  ensureRuntimeBundle,
  getRuntimePackageName,
  getRuntimePlatform,
  getRuntimeReleaseAssetName,
  materializeRuntimeBundle,
  resolvePackageRoot,
  validateFile
});
