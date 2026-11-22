import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "./parser.js";
import { checkProgram, type CheckedProgram, type ModuleExports } from "./typechecker.js";
import { generateJs } from "./codegen.js";
import { generateJsonSchema } from "./schema.js";
import { SplError } from "./errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(__dirname, "..");
export const RUNTIME_DIR = path.join(PACKAGE_ROOT, "runtime");
export const STDLIB_DIR = path.join(PACKAGE_ROOT, "stdlib");

export function normalizeFsPath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isStdlibPath(filePath: string): boolean {
  const target = normalizeFsPath(filePath);
  const stdDir = normalizeFsPath(STDLIB_DIR);
  return target === stdDir || target.startsWith(stdDir + path.sep);
}

export interface CompiledModule {
  sourcePath: string;
  outPath: string;
  checked: CheckedProgram;
  jsCode: string;
}

export interface CompileProjectResult {
  entryOutPath: string;
  modules: Map<string, CompiledModule>;
}

function stripSplExt(p: string): string {
  return p.replace(/\.splx?$/, "");
}

/** Compile a single in-memory SPL snippet (useful for tests & REPL) */
export function compileSnippet(
  source: string,
  opts: { file?: string; isStdlib?: boolean; outDir?: string; readFile?: (p: string) => string } = {}
): { checked: CheckedProgram; jsCode: string } {
  const file = opts.file ?? "<snippet>.splx";
  const readSource = opts.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const program = parse(source, file, opts.isStdlib ?? false);
  const stdCache = new Map<string, { checked: CheckedProgram; outPath: string }>();

  const resolveModule = (spec: string, fromFile: string): ModuleExports => {
    const resolved = resolveSpecToSource(spec, fromFile);
    if (!stdCache.has(resolved.sourcePath)) {
      const modSrc = readSource(resolved.sourcePath);
      const modProg = parse(modSrc, resolved.sourcePath, resolved.isStdlib);
      const checked = checkProgram(modProg, resolveModule);
      const base = path.basename(stripSplExt(resolved.sourcePath));
      const outPath = opts.outDir
        ? path.join(opts.outDir, `${base}.mjs`)
        : path.join(path.dirname(resolved.sourcePath), `${base}.mjs`);
      stdCache.set(resolved.sourcePath, { checked, outPath });
      if (opts.outDir) {
        fs.mkdirSync(opts.outDir, { recursive: true });
        const js = generateJs(checked, {
          runtimeDirUrl: pathToFileURL(RUNTIME_DIR).href,
          resolveImportPath: (s, f) => {
            const sub = resolveSpecToSource(s, f);
            return `./${path.basename(stripSplExt(sub.sourcePath))}.mjs`;
          },
        });
        fs.writeFileSync(outPath, js, "utf8");
      }
    }
    return stdCache.get(resolved.sourcePath)!.checked.exports;
  };

  const checked = checkProgram(program, resolveModule);
  const jsCode = generateJs(checked, {
    runtimeDirUrl: pathToFileURL(RUNTIME_DIR).href,
    resolveImportPath: (spec, from) => {
      const sub = resolveSpecToSource(spec, from);
      if (opts.outDir) return `./${path.basename(stripSplExt(sub.sourcePath))}.mjs`;
      return pathToFileURL(`${stripSplExt(sub.sourcePath)}.mjs`).href;
    },
  });
  return { checked, jsCode };
}

/** Compile an entry SPL file and all its transitive module imports to ESM `.mjs` files */
export function compileFile(
  entryPath: string,
  outDir: string
): CompileProjectResult {
  const absEntry = path.resolve(entryPath);
  const absOutDir = path.resolve(outDir);
  fs.mkdirSync(absOutDir, { recursive: true });

  const modules = new Map<string, CompiledModule>();
  const inProgress = new Set<string>();

  const outPathFor = (srcPath: string, isStdlib: boolean): string => {
    if (isStdlib) {
      const stdOut = path.join(absOutDir, "_std");
      fs.mkdirSync(stdOut, { recursive: true });
      return path.join(stdOut, `${path.basename(stripSplExt(srcPath))}.mjs`);
    }
    const rel = `${stripSplExt(path.relative(path.dirname(absEntry), srcPath))}.mjs`;
    const safeRel = rel.startsWith("..") ? `${path.basename(stripSplExt(srcPath))}.mjs` : rel;
    const full = path.join(absOutDir, safeRel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    return full;
  };

  const compileOne = (srcPath: string, isStdlib: boolean): CompiledModule => {
    const existing = modules.get(srcPath);
    if (existing) return existing;
    if (inProgress.has(srcPath)) {
      throw new SplError("module", `Circular module dependency detected involving '${srcPath}'`);
    }
    inProgress.add(srcPath);

    const source = fs.readFileSync(srcPath, "utf8");
    const program = parse(source, srcPath, isStdlib);

    const checked = checkProgram(program, (spec, from) => {
      const target = resolveSpecToSource(spec, from);
      return compileOne(target.sourcePath, target.isStdlib).checked.exports;
    });

    const outPath = outPathFor(srcPath, isStdlib);
    const jsCode = generateJs(checked, {
      runtimeDirUrl: pathToFileURL(RUNTIME_DIR).href,
      resolveImportPath: (spec, from) => {
        const target = resolveSpecToSource(spec, from);
        const targetOut = outPathFor(target.sourcePath, target.isStdlib);
        let rel = path.relative(path.dirname(outPath), targetOut).replace(/\\/g, "/");
        if (!rel.startsWith(".")) rel = "./" + rel;
        return rel;
      },
    });

    fs.writeFileSync(outPath, jsCode, "utf8");
    const mod: CompiledModule = { sourcePath: srcPath, outPath, checked, jsCode };
    modules.set(srcPath, mod);
    inProgress.delete(srcPath);
    return mod;
  };

  const entryMod = compileOne(absEntry, isStdlibPath(absEntry));
  return { entryOutPath: entryMod.outPath, modules };
}

/** Extract JSON Schema for a named exported/declared type in a file */
export function extractTypeSchema(filePath: string, typeName: string): Record<string, unknown> {
  const abs = path.resolve(filePath);
  const src = fs.readFileSync(abs, "utf8");
  const probe = `${src}\nlet __spl_schema_probe = type_schema<${typeName}>()\n`;
  const { checked } = compileSnippet(probe, { file: abs, isStdlib: isStdlibPath(abs) });
  for (const schema of checked.schemaLiterals.values()) {
    // Return the last schema literal (our probe)
    var last = schema;
  }
  return last!;
}

export function resolveSpecToSource(
  specifier: string,
  fromFile: string
): { sourcePath: string; isStdlib: boolean } {
  if (specifier.startsWith("std/")) {
    const modName = specifier.slice(4);
    const splxCandidate = path.join(STDLIB_DIR, `${modName}.splx`);
    if (fs.existsSync(splxCandidate)) {
      return { sourcePath: splxCandidate, isStdlib: true };
    }
    const splCandidate = path.join(STDLIB_DIR, `${modName}.spl`);
    if (fs.existsSync(splCandidate)) {
      return { sourcePath: splCandidate, isStdlib: true };
    }
    throw new SplError("module", `Unknown standard library module '${specifier}'`);
  }

  const baseDir =
    fromFile === "<snippet>.splx" || fromFile === "<snippet>.spl" || fromFile === "<input>"
      ? process.cwd()
      : path.dirname(fromFile);
  let target = path.resolve(baseDir, specifier);
  if (!target.endsWith(".splx") && !target.endsWith(".spl")) {
    if (fs.existsSync(`${target}.splx`)) target = `${target}.splx`;
    else if (fs.existsSync(`${target}.spl`)) target = `${target}.spl`;
  }
  if (!fs.existsSync(target)) {
    throw new SplError("module", `Cannot find module '${specifier}' (resolved to '${target}')`);
  }
  return { sourcePath: target, isStdlib: false };
}

export { generateJsonSchema };
