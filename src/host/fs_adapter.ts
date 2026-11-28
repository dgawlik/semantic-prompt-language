import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FsRootConfig, SignatureCatalog } from "../catalog.js";
import {
  SplObject,
  SplRecoverableError,
  SplValue,
  compareCodePoints,
  makeSplObject,
} from "../canonical.js";
import { FsOp } from "../types.js";
import { EffectDispatchResult } from "../vm.js";

export function validateVirtualPath(relPath: string): string[] {
  if (typeof relPath !== "string") {
    throw new SplRecoverableError("POLICY_DENIED", "File path must be a string", false);
  }
  if (relPath.includes("\0")) {
    throw new SplRecoverableError("POLICY_DENIED", "Null byte forbidden in virtual path", false);
  }
  if (relPath.includes("\\")) {
    throw new SplRecoverableError("POLICY_DENIED", "Backslashes forbidden in virtual path; use '/'", false);
  }
  if (relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) {
    throw new SplRecoverableError("POLICY_DENIED", "Absolute or drive-prefixed paths are forbidden", false);
  }
  if (relPath === "" || relPath === ".") return [];
  const segs = relPath.split("/");
  for (const seg of segs) {
    if (seg === "..") {
      throw new SplRecoverableError("POLICY_DENIED", "Path traversal ('..') is forbidden", false);
    }
    if (seg === "") {
      throw new SplRecoverableError("POLICY_DENIED", "Empty path segment in virtual path", false);
    }
  }
  return segs;
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const normRoot = path.resolve(rootReal);
  const normCand = path.resolve(candidateReal);
  if (normCand === normRoot) return true;
  const prefix = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
  if (process.platform === "win32") {
    return normCand.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return normCand.startsWith(prefix);
}

async function resolveSafeHostPath(rootHostDir: string, relPath: string, allowMissingLeaf: boolean): Promise<string> {
  const segs = validateVirtualPath(relPath);
  let rootReal: string;
  try {
    rootReal = await fs.realpath(rootHostDir);
  } catch {
    throw new SplRecoverableError("FS_ERROR", `Mounted fs root directory does not exist`, false);
  }

  const joined = path.resolve(rootReal, ...segs);
  if (!isInsideRoot(rootReal, joined)) {
    throw new SplRecoverableError("POLICY_DENIED", "Resolved path escapes virtual root", false);
  }

  try {
    const targetReal = await fs.realpath(joined);
    if (!isInsideRoot(rootReal, targetReal)) {
      throw new SplRecoverableError("POLICY_DENIED", "Symlink target escapes virtual root", false);
    }
    return targetReal;
  } catch (err) {
    if (err instanceof SplRecoverableError) throw err;
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" || !allowMissingLeaf) {
      if (code === "ENOENT") {
        throw new SplRecoverableError("FS_NOT_FOUND", `Path not found: '${relPath}'`, false);
      }
      throw new SplRecoverableError("FS_ERROR", err instanceof Error ? err.message : String(err), false);
    }
    // Walk up to nearest existing ancestor and ensure no symlink escape
    let ancestor = path.dirname(joined);
    const trailing: string[] = [path.basename(joined)];
    while (true) {
      try {
        const ancReal = await fs.realpath(ancestor);
        if (!isInsideRoot(rootReal, ancReal)) {
          throw new SplRecoverableError("POLICY_DENIED", "Ancestor symlink escapes virtual root", false);
        }
        return path.join(ancReal, ...trailing.reverse());
      } catch (e2) {
        if (e2 instanceof SplRecoverableError) throw e2;
        if (ancestor === rootReal || path.dirname(ancestor) === ancestor) {
          throw new SplRecoverableError("POLICY_DENIED", "Path escapes virtual root", false);
        }
        trailing.push(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
  }
}

export class VirtualFsAdapter {
  constructor(
    private readonly catalog: SignatureCatalog,
    private readonly rootMounts: Record<string, string>
  ) {}

  async execute(args: SplObject): Promise<EffectDispatchResult> {
    const op = args.op as FsOp;
    const rootName = args.root as string;
    const relPath = args.path as string;

    const rootCfg: FsRootConfig | undefined = this.catalog.fs_roots[rootName];
    const hostDir = this.rootMounts[rootName];
    if (!rootCfg || !hostDir) {
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError("POLICY_DENIED", `Unknown or unmounted fs root '${rootName}'`, false).errObj,
        },
      };
    }
    if (!rootCfg.permissions.includes(op)) {
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError(
            "POLICY_DENIED",
            `fs root '${rootName}' denies '${op}' operation`,
            false
          ).errObj,
        },
      };
    }

    try {
      const value = await this.runOp(op, hostDir, rootCfg, relPath, args.content as string | undefined);
      return { outcome: { status: "ok", value } };
    } catch (err) {
      if (err instanceof SplRecoverableError) {
        return { outcome: { status: "error", error: err.errObj } };
      }
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError("FS_ERROR", err instanceof Error ? err.message : String(err), false).errObj,
        },
      };
    }
  }

  private async runOp(
    op: FsOp,
    hostDir: string,
    cfg: FsRootConfig,
    relPath: string,
    content?: string
  ): Promise<SplValue> {
    switch (op) {
      case "read": {
        const safePath = await resolveSafeHostPath(hostDir, relPath, false);
        const st = await fs.stat(safePath);
        if (st.size > cfg.max_file_bytes) {
          throw new SplRecoverableError(
            "FS_LIMIT_EXCEEDED",
            `File size ${st.size} exceeds max_file_bytes (${cfg.max_file_bytes})`,
            false
          );
        }
        return fs.readFile(safePath, "utf8");
      }

      case "write": {
        const text = content ?? "";
        const byteLen = Buffer.byteLength(text, "utf8");
        if (byteLen > cfg.max_file_bytes) {
          throw new SplRecoverableError(
            "FS_LIMIT_EXCEEDED",
            `Write size ${byteLen} exceeds max_file_bytes (${cfg.max_file_bytes})`,
            false
          );
        }
        const safePath = await resolveSafeHostPath(hostDir, relPath, true);
        await fs.mkdir(path.dirname(safePath), { recursive: true });
        await fs.writeFile(safePath, text, "utf8");
        return null;
      }

      case "append": {
        const text = content ?? "";
        const addBytes = Buffer.byteLength(text, "utf8");
        const safePath = await resolveSafeHostPath(hostDir, relPath, true);
        let curBytes = 0;
        try {
          const st = await fs.stat(safePath);
          curBytes = st.size;
        } catch {
          curBytes = 0;
        }
        if (curBytes + addBytes > cfg.max_file_bytes) {
          throw new SplRecoverableError(
            "FS_LIMIT_EXCEEDED",
            `Appended file size ${curBytes + addBytes} exceeds max_file_bytes (${cfg.max_file_bytes})`,
            false
          );
        }
        await fs.mkdir(path.dirname(safePath), { recursive: true });
        await fs.appendFile(safePath, text, "utf8");
        return null;
      }

      case "exists": {
        try {
          const safePath = await resolveSafeHostPath(hostDir, relPath, false);
          await fs.access(safePath);
          return true;
        } catch (err) {
          if (err instanceof SplRecoverableError && err.errObj.code === "POLICY_DENIED") throw err;
          return false;
        }
      }

      case "list": {
        const safePath = await resolveSafeHostPath(hostDir, relPath, false);
        const entries = await fs.readdir(safePath);
        return entries.sort(compareCodePoints);
      }

      case "stat": {
        try {
          const safePath = await resolveSafeHostPath(hostDir, relPath, false);
          const st = await fs.stat(safePath);
          return makeSplObject([
            ["exists", true],
            ["is_dir", st.isDirectory()],
            ["is_file", st.isFile()],
            ["size_bytes", BigInt(st.size)],
          ]);
        } catch (err) {
          if (err instanceof SplRecoverableError && err.errObj.code === "POLICY_DENIED") throw err;
          return makeSplObject([
            ["exists", false],
            ["is_dir", false],
            ["is_file", false],
            ["size_bytes", 0n],
          ]);
        }
      }
    }
  }
}
