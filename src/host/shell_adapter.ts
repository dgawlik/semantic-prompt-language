import { execFile } from "node:child_process";
import { SignatureCatalog } from "../catalog.js";
import { SplObject, SplRecoverableError, makeSplObject } from "../canonical.js";
import { EffectDispatchResult } from "../vm.js";

function renderArgvTemplate(template: string[], args: SplObject): string[] {
  const out: string[] = [];
  for (const token of template) {
    const exactMatch = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(token);
    if (exactMatch) {
      const val = args[exactMatch[1]];
      if (val === undefined || val === null) {
        continue; // skip optional absent parameter
      }
      out.push(String(val));
      continue;
    }
    let skip = false;
    const rendered = token.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key: string) => {
      const val = args[key];
      if (val === undefined || val === null) {
        skip = true;
        return "";
      }
      return String(val);
    });
    if (!skip) out.push(rendered);
  }
  return out;
}

function truncateUtf8(buf: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  if (buf.byteLength <= maxBytes) {
    return { text: buf.toString("utf8"), truncated: false };
  }
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export class ShellProfileAdapter {
  constructor(
    private readonly catalog: SignatureCatalog,
    private readonly rootMounts: Record<string, string>
  ) {}

  async execute(profileName: string, args: SplObject): Promise<EffectDispatchResult> {
    const profile = this.catalog.shell_profiles[profileName];
    if (!profile) {
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError("POLICY_DENIED", `Unknown shell profile '${profileName}'`, false).errObj,
        },
      };
    }

    const cwd = this.rootMounts[profile.cwd_root];
    if (!cwd) {
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError(
            "POLICY_DENIED",
            `Shell profile cwd_root '${profile.cwd_root}' is not mounted`,
            false
          ).errObj,
        },
      };
    }

    // §6.4 Construct explicit argv array; NEVER invoke a shell interpreter
    const argv = [...profile.base_argv, ...renderArgvTemplate(profile.argv_template, args)];

    const env: Record<string, string> = {};
    for (const k of profile.env_allowlist) {
      if (process.env[k] !== undefined) {
        env[k] = process.env[k]!;
      }
    }

    return new Promise<EffectDispatchResult>((resolve) => {
      const startMs = Date.now();
      const child = execFile(
        profile.executable,
        argv,
        {
          cwd,
          env,
          shell: false,
          timeout: profile.timeout_ms,
          maxBuffer: Math.max(profile.max_stdout_bytes, profile.max_stderr_bytes) * 4 + 65536,
          encoding: "buffer",
        },
        (err, stdoutBuf, stderrBuf) => {
          const latencyMs = Date.now() - startMs;
          const outB = Buffer.isBuffer(stdoutBuf) ? stdoutBuf : Buffer.from(stdoutBuf ?? "");
          const errB = Buffer.isBuffer(stderrBuf) ? stderrBuf : Buffer.from(stderrBuf ?? "");

          if (err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            resolve({
              outcome: {
                status: "error",
                error: new SplRecoverableError(
                  "SHELL_ERROR",
                  `Shell profile '${profileName}' timed out after ${profile.timeout_ms}ms`,
                  true
                ).errObj,
              },
              non_normative_meta: { latency_ms: latencyMs },
            });
            return;
          }

          const codeNum =
            err && typeof (err as { code?: unknown }).code === "number"
              ? ((err as unknown as { code: number }).code as number)
              : err
                ? null
                : 0;

          if (codeNum === null) {
            resolve({
              outcome: {
                status: "error",
                error: new SplRecoverableError(
                  "SHELL_ERROR",
                  `Failed to spawn '${profile.executable}': ${err?.message ?? "unknown error"}`,
                  false
                ).errObj,
              },
              non_normative_meta: { latency_ms: latencyMs },
            });
            return;
          }

          const outTrunc = truncateUtf8(outB, profile.max_stdout_bytes);
          const errTrunc = truncateUtf8(errB, profile.max_stderr_bytes);

          resolve({
            outcome: {
              status: "ok",
              value: makeSplObject([
                ["exit_code", BigInt(codeNum)],
                ["stderr", errTrunc.text],
                ["stdout", outTrunc.text],
                ["truncated", outTrunc.truncated || errTrunc.truncated],
              ]),
            },
            non_normative_meta: { latency_ms: latencyMs },
          });
        }
      );
      void child;
    });
  }
}
