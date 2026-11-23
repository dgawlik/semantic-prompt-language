#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { pathToFileURL } from "node:url";
import { compileFile, extractTypeSchema } from "./compiler.js";
import {
  CREDENTIAL_PROVIDERS,
  PROVIDER_ENV_VARS,
  getCredentialsPath,
  maskToken,
  normalizeProviderName,
  readCredentials,
  writeCredentials,
  type CredentialProvider,
} from "./credentials.js";
import { SplError } from "./errors.js";
import { startLspServer } from "./lsp.js";

function promptLine(question: string, mask = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;

    if (!mask || !input.isTTY || typeof input.setRawMode !== "function") {
      const rl = readline.createInterface({ input, output });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    output.write(question);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding?.("utf8");

    let value = "";
    const cleanup = () => {
      input.removeListener("data", onData);
      input.setRawMode?.(Boolean(wasRaw));
      input.pause();
    };

    const onData = (rawChunk: Uint8Array | string) => {
      const chunk = typeof rawChunk === "string" ? rawChunk : Buffer.from(rawChunk).toString("utf8");
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl+C
          cleanup();
          output.write("\n");
          reject(new Error("Login cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        value += ch;
        output.write("*");
      }
    };

    input.on("data", onData);
  });
}

async function runLogin(args: string[]): Promise<void> {
  const credsPath = getCredentialsPath();
  const existing = readCredentials(credsPath);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        "Save LLM provider API tokens in your home directory (~/.spl/credentials.json).",
        "",
        "Usage:",
        "  spl login                                  Interactive prompt for openai, google, anthropic",
        "  spl login <provider> [token]               Save token for one provider (openai | google | anthropic)",
        "  spl login --openai <k> --google <k> ...    Non-interactive flags",
        "  spl login --from-env                       Import OPENAI_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY",
        "  spl login --status                         Show saved providers (masked)",
        "  spl login --clear [provider]               Remove saved token(s)",
      ].join("\n")
    );
    return;
  }

  if (args.includes("--status") || args[0] === "status") {
    console.log(`Credentials file: ${credsPath}`);
    for (const p of CREDENTIAL_PROVIDERS) {
      const val = existing[p];
      console.log(`  ${p.padEnd(10)} ${val ? maskToken(val) : "(not set)"}`);
    }
    return;
  }

  const clearIdx = args.indexOf("--clear");
  if (clearIdx !== -1 || args[0] === "logout") {
    const targetRaw = clearIdx !== -1 ? args[clearIdx + 1] : args[1];
    if (targetRaw && !targetRaw.startsWith("-")) {
      const prov = normalizeProviderName(targetRaw);
      if (!prov) {
        throw new Error(`Unknown provider '${targetRaw}'. Expected one of: openai, google, anthropic`);
      }
      delete existing[prov];
      writeCredentials(existing, credsPath);
      console.log(`Cleared '${prov}' token in ${credsPath}`);
    } else {
      writeCredentials({}, credsPath);
      console.log(`Cleared all saved tokens in ${credsPath}`);
    }
    return;
  }

  const next = { ...existing };
  let updatedAny = false;

  // 1. Import from environment variables (`--from-env`)
  if (args.includes("--from-env")) {
    for (const p of CREDENTIAL_PROVIDERS) {
      for (const envName of PROVIDER_ENV_VARS[p]) {
        const envVal = process.env[envName]?.trim();
        if (envVal) {
          next[p] = envVal;
          updatedAny = true;
          break;
        }
      }
    }
  }

  // 2. Named flags: `--openai <token>`, `--google <token>`, `--anthropic <token>`
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--from-env") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const flagName = (eq === -1 ? a.slice(2) : a.slice(2, eq)).toLowerCase();
      const prov = normalizeProviderName(flagName);
      if (!prov) {
        throw new Error(`Unknown option '${a}'. Run 'spl login --help' for usage.`);
      }
      const val = eq === -1 ? args[++i] : a.slice(eq + 1);
      if (val === undefined) {
        throw new Error(`Missing token value after '${a}'`);
      }
      if (val.trim() === "" || val.trim() === "-") {
        delete next[prov];
      } else {
        next[prov] = val.trim();
      }
      updatedAny = true;
    } else {
      positionals.push(a);
    }
  }

  // 3. Positional form: `spl login <provider> [token]`
  if (positionals.length > 0) {
    const prov = normalizeProviderName(positionals[0]);
    if (!prov) {
      throw new Error(
        `Unknown provider '${positionals[0]}'. Expected one of: openai, google, anthropic`
      );
    }
    if (positionals[1] !== undefined) {
      const val = positionals[1].trim();
      if (val === "" || val === "-") delete next[prov];
      else next[prov] = val;
      updatedAny = true;
    } else {
      const hint = existing[prov] ? ` [saved: ${maskToken(existing[prov]!)}]` : "";
      const entered = (await promptLine(`${prov} API key${hint} (Enter to keep, '-' to clear): `, true)).trim();
      if (entered === "-") {
        delete next[prov];
        updatedAny = true;
      } else if (entered !== "") {
        next[prov] = entered;
        updatedAny = true;
      }
    }
  } else if (!updatedAny) {
    // 4. Interactive prompt for all three providers
    console.log(`Saving API tokens to ${credsPath}`);
    console.log("Press Enter to keep an existing key, or type '-' to clear it.\n");
    for (const prov of CREDENTIAL_PROVIDERS) {
      const hint = existing[prov] ? ` [saved: ${maskToken(existing[prov]!)}]` : "";
      const entered = (await promptLine(`${prov} API key${hint}: `, true)).trim();
      if (entered === "-") {
        delete next[prov];
        updatedAny = true;
      } else if (entered !== "") {
        next[prov] = entered;
        updatedAny = true;
      }
    }
  }

  const savedPath = writeCredentials(next, credsPath);
  const configured = CREDENTIAL_PROVIDERS.filter((p): p is CredentialProvider => Boolean(next[p]));
  console.log(`Saved credentials -> ${savedPath}`);
  console.log(
    configured.length > 0
      ? `Configured providers: ${configured.map((p) => `${p} (${maskToken(next[p]!)})`).join(", ")}`
      : "No providers configured."
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(
      [
        "SPL — Semantic Prompt Language Compiler",
        "",
        "Usage:",
        "  spl check <file.splx>             Type-check a file and its imports",
        "  spl build <file.splx> [-o dir]    Compile to ESM JavaScript (.mjs)",
        "  spl run <file.splx>               Compile and execute",
        "  spl login [provider] [token]      Save LLM API tokens in ~/.spl/credentials.json",
        "  spl schema <file.splx> <Type>     Print JSON Schema for a type",
        "  spl lsp                           Start the Language Server (stdio)",
      ].join("\n")
    );
    return;
  }

  try {
    if (cmd === "login") {
      await runLogin(args.slice(1));
      return;
    }
    if (cmd === "check") {
      const file = args[1];
      if (!file) throw new Error("Missing input file: spl check <file.spl>");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-check-"));
      try {
        const res = compileFile(file, tmpDir);
        console.log(`OK (${res.modules.size} module(s) checked)`);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      return;
    }

    if (cmd === "build") {
      const file = args[1];
      if (!file) throw new Error("Missing input file: spl build <file.spl> [-o outDir]");
      const outIdx = args.indexOf("-o");
      const outDir = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : "./dist-spl";
      const res = compileFile(file, outDir);
      console.log(`Built ${res.modules.size} module(s) -> ${res.entryOutPath}`);
      return;
    }

    if (cmd === "run") {
      const file = args[1];
      if (!file) throw new Error("Missing input file: spl run <file.spl>");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-run-"));
      try {
        const res = compileFile(file, tmpDir);
        await import(pathToFileURL(res.entryOutPath).href);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      return;
    }

    if (cmd === "schema") {
      const file = args[1];
      const typeName = args[2];
      if (!file || !typeName) throw new Error("Usage: spl schema <file.splx> <TypeName>");
      const schema = extractTypeSchema(file, typeName);
      console.log(JSON.stringify(schema, null, 2));
      return;
    }

    if (cmd === "lsp") {
      startLspServer();
      return;
    }

    throw new Error(`Unknown command '${cmd}'. Run 'spl --help' for usage.`);
  } catch (err) {
    if (err instanceof SplError) {
      console.error(err.message);
    } else if (err instanceof Error) {
      console.error(err.message);
    } else if (err && typeof err === "object" && err.toString === Object.prototype.toString) {
      console.error(JSON.stringify(err));
    } else {
      console.error(String(err));
    }
    process.exit(1);
  }
}

main();
