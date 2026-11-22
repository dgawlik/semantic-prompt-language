// SPL Server-Only FFI Kernel (Node 22+ / Bun / Deno)
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Ok, Err, Some, None, toStr } from "./core.mjs";

const execFileAsync = promisify(execFile);

// ==================== fs ====================

export async function fsRead(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return Ok(content);
  } catch (e) {
    return Err(e instanceof Error ? e.message : String(e));
  }
}

export async function fsWrite(filePath, data) {
  try {
    await fs.writeFile(filePath, data, "utf8");
    return Ok(undefined);
  } catch (e) {
    return Err(e instanceof Error ? e.message : String(e));
  }
}

export async function fsStat(filePath) {
  try {
    const st = await fs.stat(filePath);
    return Ok({
      is_file: st.isFile(),
      is_dir: st.isDirectory(),
      size: st.size,
      mtime_ms: Math.trunc(st.mtimeMs),
    });
  } catch (e) {
    return Err(e instanceof Error ? e.message : String(e));
  }
}

export async function fsListDir(dirPath) {
  try {
    const entries = await fs.readdir(dirPath);
    return Ok(entries);
  } catch (e) {
    return Err(e instanceof Error ? e.message : String(e));
  }
}

export async function fsMkdir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    return Ok(undefined);
  } catch (e) {
    return Err(e instanceof Error ? e.message : String(e));
  }
}

export async function fsRemove(targetPath) {
  try {
    await fs.rm(targetPath, { recursive: true, force: true });
    return Ok(undefined);
  } catch (e) {
    return Err(e instanceof Error ? e.message : String(e));
  }
}

// ==================== proc ====================

export async function procExec(cmd, args, opts) {
  try {
    const execOpts = {
      cwd: opts?.cwd?.$tag === "Some" ? opts.cwd._0 : undefined,
      timeout: opts?.timeout_ms?.$tag === "Some" ? opts.timeout_ms._0 : undefined,
      maxBuffer: 10 * 1024 * 1024,
    };
    const { stdout, stderr } = await execFileAsync(cmd, args, execOpts);
    return Ok({ code: 0, stdout: String(stdout), stderr: String(stderr) });
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && typeof e.code === "number") {
      return Ok({
        code: e.code,
        stdout: String(e.stdout ?? ""),
        stderr: String(e.stderr ?? ""),
      });
    }
    return Err(e instanceof Error ? e.message : String(e));
  }
}

// ==================== os ====================

export function osEnv(key) {
  const val = process.env[key];
  return val === undefined ? None : Some(val);
}

export function osArgs() {
  return process.argv.slice(2);
}

export function osCwd() {
  return process.cwd();
}

export function osPlatform() {
  return process.platform;
}

export function osExit(code) {
  process.exit(code);
}

export function osPrint(v) {
  process.stdout.write(toStr(v) + "\n");
}

export function osWrite(v) {
  process.stdout.write(toStr(v));
}
