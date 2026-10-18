import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { COPILOT_CLI_USE_NPM_PACKAGE } from "./cliVersion.js";
const require2 = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
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
  if (!existsSync(path)) {
    throw new Error(`${label} not found at ${path}.`);
  }
  if (statSync(path).size === 0) {
    throw new Error(`${label} at ${path} is empty.`);
  }
}
function validateRuntimeBundle(wrapper, runtimeNode) {
  validateFile(wrapper, "Copilot runtime wrapper");
  validateFile(runtimeNode, "Copilot runtime.node");
}
function isExcluded(relativePath) {
  const parts = relativePath.split(sep);
  const topLevel = parts[0];
  const fileName = parts.at(-1) ?? "";
  return EXCLUDED_TOP_LEVEL.has(topLevel) || /^tree-sitter.*\.wasm$/.test(topLevel) || /^voice-.*\.js$/.test(topLevel) || fileName === "cli-native.node" || parts.includes("mediaremote-adapter") || fileName.startsWith("copilot-runtime-bin");
}
function collectRuntimeAssets(sources) {
  const assets = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      const sourceRelative = relative(sources.packageRoot, source);
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
      const parts = sourceRelative.split(sep);
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
  const hash = createHash("sha256");
  for (const asset of assets) {
    const stat = lstatSync(asset.source);
    hash.update(asset.relativePath).update("\0");
    hash.update(`${stat.size}:${stat.mtimeMs}`).update("\0");
  }
  return hash.digest("hex").slice(0, 20);
}
function makeExecutable(path) {
  if (process.platform === "win32") {
    return;
  }
  const mode = statSync(path).mode;
  if ((mode & 73) === 0) {
    chmodSync(path, mode | 73);
  }
}
function defaultRuntimeCacheRoot(platform = process.platform, home = homedir(), environment = process.env) {
  const cacheDirectory = platform === "win32" ? environment.LOCALAPPDATA ?? join(home, "AppData", "Local") : platform === "darwin" ? join(home, "Library", "Caches") : environment.XDG_CACHE_HOME ?? join(home, ".cache");
  return join(cacheDirectory, "github-copilot-sdk", "runtime");
}
function materializeRuntimeBundle(sources, cacheRoot = defaultRuntimeCacheRoot(), cacheKey = `${sources.platform}-${sourceFingerprint(collectRuntimeAssets(sources))}`) {
  const assets = collectRuntimeAssets(sources);
  const wrapperName = sources.platform.startsWith("win32") ? "copilot-runtime.exe" : "copilot-runtime";
  const prebuildDir = join("prebuilds", sources.platform);
  const wrapperRelative = join(prebuildDir, wrapperName);
  const runtimeNodeRelative = join(prebuildDir, "runtime.node");
  const sourceWrapper = assets.find((asset) => asset.relativePath === wrapperRelative)?.source;
  const sourceRuntimeNode = assets.find(
    (asset) => asset.relativePath === runtimeNodeRelative
  )?.source;
  validateRuntimeBundle(sourceWrapper ?? "", sourceRuntimeNode ?? "");
  const installDir = join(cacheRoot, cacheKey);
  const installedWrapper = join(installDir, wrapperRelative);
  const installedRuntimeNode = join(installDir, runtimeNodeRelative);
  if (existsSync(installDir)) {
    validateRuntimeBundle(installedWrapper, installedRuntimeNode);
    makeExecutable(installedWrapper);
    return installedWrapper;
  }
  mkdirSync(cacheRoot, { recursive: true });
  const stagingDir = mkdtempSync(join(cacheRoot, ".runtime-"));
  try {
    for (const asset of assets) {
      const destination = join(stagingDir, asset.relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(asset.source, destination);
    }
    const stagedWrapper = join(stagingDir, wrapperRelative);
    makeExecutable(stagedWrapper);
    renameSync(stagingDir, installDir);
  } catch (error) {
    if (!existsSync(installDir)) {
      throw error;
    }
    validateRuntimeBundle(installedWrapper, installedRuntimeNode);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
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
  return searchPaths.map((base) => join(base, ...packageName.split("/"))).find((candidate) => existsSync(join(candidate, "package.json")));
}
async function ensureRuntimeBundle(version, options = {}) {
  const platform = options.platform ?? getRuntimePlatform();
  if (COPILOT_CLI_USE_NPM_PACKAGE) {
    const packageName2 = `@github/copilot-${platform}`;
    const packageRoot2 = resolvePackageRoot(packageName2, options.packageSearchPaths);
    if (!packageRoot2) {
      throw new Error(`Could not resolve ${packageName2} for Copilot CLI ${version}.`);
    }
    validateFile(
      join(packageRoot2, "prebuilds", platform, "runtime.node"),
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
  const prebuildDir = join(packageRoot, "prebuilds", platform);
  const wrapper = join(prebuildDir, wrapperName);
  try {
    validateRuntimeBundle(wrapper, join(prebuildDir, "runtime.node"));
  } catch (error) {
    throw new Error(
      `${packageName} is missing required Copilot CLI runtime files. Reinstall @github/copilot-sdk.`,
      { cause: error }
    );
  }
  makeExecutable(wrapper);
  return wrapper;
}
export {
  RUNTIME_PLATFORMS,
  defaultRuntimeCacheRoot,
  ensureRuntimeBundle,
  getRuntimePackageName,
  getRuntimePlatform,
  getRuntimeReleaseAssetName,
  materializeRuntimeBundle,
  resolvePackageRoot,
  validateFile
};
