#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { compileFile, extractTypeSchema } from "./compiler.js";
import { SplError } from "./errors.js";
import { startLspServer } from "./lsp.js";

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
        "  spl schema <file.splx> <Type>     Print JSON Schema for a type",
        "  spl lsp                           Start the Language Server (stdio)",
      ].join("\n")
    );
    return;
  }

  try {
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
