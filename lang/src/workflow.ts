import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from './compile.js';
import { SplSyntaxError, type FailurePayload } from './errors.js';
import * as packageModule from './index.js';
import { library } from './library.js';
import type { LlmBackend } from './llm.js';
import { importWorkflow, provideLibrary } from './loader.js';
import type { Logger } from './logger.js';
import * as markdownModule from './markdown-lib.js';
import { Runtime, type HumanHandler, type Step } from './runtime.js';
import { TraceError, type Trace } from './trace.js';

export interface RunOptions {
    backend: LlmBackend;
    logger: Logger;
    /** Path of the workflow: its imports resolve from here, generated code is cached beside it and failures name it. */
    file?: string;
    /** Working directory for relative paths, `restrict` folders and tools. */
    cwd?: string;
    /** Overrides file defaults and per-call models. */
    model?: string;
    /** Default step limit per agent call. */
    maxSteps?: number;
    /** Maximum cumulative tokens allowed across all model calls. */
    maxTotalTokens?: number;
    /** Maximum cumulative estimated USD cost allowed across all model calls. */
    maxCostUsd?: number;
    /** Script arguments exposed as the read-only `args`; defaults to an empty list. */
    args?: readonly string[];
    trace?: Trace;
    /** Answers `human()` and the agents' `askHuman` calls. */
    human?: HumanHandler;
    /** Awaited before each `---` block and each top-level statement; the CLI `--debug` stepper pauses here. */
    beforeStep?: (step: Step) => void | Promise<void>;
}

export type RunResult =
    | { status: 'success'; value: unknown; hasValue: boolean }
    | { status: 'failure'; failure: FailurePayload };

let runs = 0;

// `import ... from 'spl-lang'` in workflows and their helper modules resolves to this running copy.
provideLibrary({ 'spl-lang': packageModule, 'spl-lang/markdown': markdownModule }, Object.keys(library()));

/**
 * Compiles a `.spl` source in memory and runs it once. Syntax errors throw `SplSyntaxError` before
 * anything runs; a failure of the workflow is returned as a result.
 */
export async function run(source: string, options: RunOptions): Promise<RunResult> {
    const { logger, trace } = options;
    // Compiled here first, so problems are reported before a runtime or a trace is touched.
    const { imports, scan } = compile(source, { eval: /\.eval\.spl$/i.test(options.file ?? '') });
    const runtime = new Runtime({
        backend: options.backend, logger, cwd: options.cwd, model: options.model,
        maxSteps: options.maxSteps, maxTotalTokens: options.maxTotalTokens, maxCostUsd: options.maxCostUsd,
        args: options.args, trace, human: options.human, beforeStep: options.beforeStep,
    });
    const file = path.resolve(runtime.cwd, options.file ?? 'workflow.spl');
    // A fresh URL per run: Node caches modules by URL, and the same file may run again after an edit.
    const url = `${pathToFileURL(file).href}?run=${++runs}`;
    try {
        trace?.validateSource(source, options.args);
        const module = await importWorkflow(url, { source, instrument: runtime.instrumented });
        const value = await runtime.run(() => (module.default as (args: readonly string[]) => Promise<unknown>)(runtime.args));
        trace?.assertConsumed();
        return { status: 'success', value: value ?? null, hasValue: value !== undefined };
    } catch (error) {
        if (error instanceof TraceError || error instanceof SplSyntaxError) throw error;
        // A module that cannot be found fails before the workflow starts: the import that names it is the place.
        const missing = (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' ? imports.find(item => {
            const target = /^\.{1,2}\//.test(item.specifier) ? path.resolve(path.dirname(file), item.specifier) : item.specifier;
            return String((error as Error).message).includes(`'${target}'`);
        }) : undefined;
        const failure = runtime.failure(error, missing && { line: missing.line, command: scan.lines[missing.line - 1].trim() });
        // Failures in the workflow itself need no file; elsewhere they name it.
        if (failure.source === url) failure.source = undefined;
        else if (failure.source?.startsWith('file:')) failure.source = fileURLToPath(failure.source);
        trace?.assertConsumed();
        logger.error(`${failure.statusCode}: ${failure.reason} (line ${failure.line})`);
        return { status: 'failure', failure: failure.payload() };
    }
}
