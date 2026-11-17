import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from './compile.js';
import { Failure, SplSyntaxError } from './errors.js';
import type { EvalRegistration, EvalScope, JudgeResult } from './judge.js';
import type { LlmBackend } from './llm.js';
import { importWorkflow } from './loader.js';
import { Logger } from './logger.js';
import { Runtime } from './runtime.js';
import { Trace, TraceError, fingerprint } from './trace.js';
import { traceHtml, tracePaths } from './trace-html.js';

export class EvalUsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EvalUsageError';
    }
}

export interface EvalAttemptResult {
    run: number;
    pass: boolean;
    assertions: JudgeResult[];
    error?: string;
    durationMs: number;
}

export interface EvalCaseResult {
    file: string;
    name: string;
    pass: boolean;
    runs: EvalAttemptResult[];
    durationMs: number;
}

export interface EvalSuiteResult {
    pass: boolean;
    total: number;
    passed: number;
    failed: number;
    results: EvalCaseResult[];
    durationMs: number;
}

export interface EvalRunOptions {
    files: readonly string[];
    cwd: string;
    filter?: string;
    runs?: number;
    concurrency?: number;
    model?: string;
    judgeModel?: string;
    trace?: string;
    runtimeFingerprint?: string;
    traceConfig?: unknown;
    backendFactory: (logger: Logger) => LlmBackend;
    logger?: Logger;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out']);
let evalLoads = 0;

function walkEvalFiles(dir: string, out: Set<string>): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.spl-check-')) continue;
            walkEvalFiles(path.join(dir, entry.name), out);
        } else if (entry.isFile() && /\.eval\.spl$/i.test(entry.name)) {
            out.add(path.resolve(dir, entry.name));
        }
    }
}

/** Discovers `*.eval.spl` files in `cwd` by default, or from explicit file/directory targets. */
export function discoverEvalFiles(targets: readonly string[], cwd: string): string[] {
    const found = new Set<string>();
    if (!targets.length) {
        walkEvalFiles(cwd, found);
        return [...found].sort();
    }
    for (const target of targets) {
        const resolved = path.resolve(cwd, target);
        let stat: fs.Stats;
        try {
            stat = fs.statSync(resolved);
        } catch (error) {
            throw new EvalUsageError(`cannot access '${target}': ${(error as Error).message}`);
        }
        if (stat.isDirectory()) {
            walkEvalFiles(resolved, found);
        } else if (stat.isFile()) {
            if (!/\.eval\.spl$/i.test(resolved)) {
                throw new EvalUsageError(`'${target}' is not a *.eval.spl file`);
            }
            found.add(resolved);
        }
    }
    return [...found].sort();
}

function matchesFilter(name: string, pattern: string): boolean {
    try {
        return new RegExp(pattern, 'i').test(name);
    } catch {
        return name.toLowerCase().includes(pattern.toLowerCase());
    }
}

function traceTargetFor(base: string, index: number, total: number) {
    if (total <= 1) return tracePaths(base);
    const stem = base.replace(/\.jsonl$/i, '');
    return tracePaths(`${stem}-${index + 1}`);
}

/** Compiles, discovers, and executes `*.eval.spl` cases with isolation, concurrency, and soft assertions. */
export async function runEvals(options: EvalRunOptions): Promise<EvalSuiteResult> {
    const suiteStart = Date.now();
    const runs = options.runs ?? 1;
    const concurrency = options.concurrency ?? 1;
    const logger = options.logger ?? new Logger('silent');

    interface LoadedCase {
        file: string;
        source: string;
        evalCase: EvalRegistration;
    }

    const cases: LoadedCase[] = [];
    for (const file of options.files) {
        let source: string;
        try {
            source = fs.readFileSync(file, 'utf8');
        } catch (error) {
            throw new EvalUsageError(`cannot read '${file}': ${(error as Error).message}`);
        }
        try {
            compile(source, { eval: true });
        } catch (error) {
            if (error instanceof SplSyntaxError && !error.file) error.file = file;
            throw error;
        }
        const collector: EvalRegistration[] = [];
        const discoveryRuntime = new Runtime({
            backend: options.backendFactory(new Logger('silent')),
            logger: new Logger('silent'),
            cwd: options.cwd,
            model: options.model,
            judgeModel: options.judgeModel,
        });
        const url = `${pathToFileURL(file).href}?eval=${++evalLoads}`;
        const mod = await importWorkflow(url, { source });
        await discoveryRuntime.run(
            () => (mod.default as (args: readonly string[]) => Promise<unknown>)([]),
            { ...discoveryRuntime.root, evalCollector: collector },
        );
        for (const evalCase of collector) {
            if (!options.filter || matchesFilter(evalCase.name, options.filter)) {
                cases.push({ file, source, evalCase });
            }
        }
    }

    const totalAttempts = cases.length * runs;
    const attemptResults: EvalAttemptResult[][] = cases.map(() => new Array<EvalAttemptResult>(runs));
    const queue: { caseIndex: number; runIndex: number; attemptNumber: number }[] = [];
    let attemptNumber = 0;
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
        for (let runIndex = 0; runIndex < runs; runIndex++) {
            queue.push({ caseIndex, runIndex, attemptNumber: attemptNumber++ });
        }
    }

    let cursor = 0;
    const worker = async (): Promise<void> => {
        while (cursor < queue.length) {
            const task = queue[cursor++];
            const { file, source, evalCase } = cases[task.caseIndex];
            const attemptStart = Date.now();
            const backend = options.backendFactory(logger);
            const traceTarget = options.trace ? traceTargetFor(options.trace, task.attemptNumber, totalAttempts) : undefined;
            let trace: Trace | undefined;
            if (traceTarget) {
                trace = Trace.open(traceTarget.jsonl, {
                    source,
                    cwd: options.cwd,
                    runtime: options.runtimeFingerprint ?? fingerprint(['eval', evalCase.name, task.runIndex]),
                    configuration: options.traceConfig ?? { model: options.model ?? null, judgeModel: options.judgeModel ?? null },
                });
            }
            const runtime = new Runtime({
                backend,
                logger,
                cwd: options.cwd,
                model: options.model,
                judgeModel: options.judgeModel,
                trace,
            });
            const evalScope: EvalScope = {
                phase: 'arrange',
                pendingArrange: [],
                pendingJudges: [],
                results: [],
            };
            let errorMessage: string | undefined;
            try {
                await runtime.run(async () => {
                    await evalCase.fn();
                    if (evalScope.pendingArrange.length) {
                        await Promise.all(evalScope.pendingArrange.splice(0));
                    }
                    if (evalScope.pendingJudges.length) {
                        await Promise.all(evalScope.pendingJudges);
                    }
                }, { ...runtime.root, evalScope });
                trace?.assertConsumed();
                trace?.finish({ status: 'success', value: null, hasValue: false });
            } catch (error) {
                if (error instanceof TraceError || error instanceof SplSyntaxError) throw error;
                const failure = error instanceof Failure ? error : runtime.failure(error);
                errorMessage = failure.reason;
                trace?.finish({ status: 'failure', failure: failure.payload() });
            } finally {
                try {
                    await backend.close();
                } catch { /* best-effort close */ }
                trace?.close();
                if (traceTarget && fs.existsSync(traceTarget.jsonl)) {
                    const journal = fs.readFileSync(traceTarget.jsonl, 'utf8');
                    fs.writeFileSync(traceTarget.html, traceHtml(journal, {
                        title: `${path.basename(file)}: ${evalCase.name}`,
                        source,
                        traceFile: path.basename(traceTarget.jsonl),
                    }), 'utf8');
                }
            }
            const pass = errorMessage === undefined && evalScope.results.every(r => r.pass);
            attemptResults[task.caseIndex][task.runIndex] = {
                run: task.runIndex + 1,
                pass,
                assertions: evalScope.results,
                ...(errorMessage !== undefined ? { error: errorMessage } : {}),
                durationMs: Date.now() - attemptStart,
            };
        }
    };

    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, () => worker());
    await Promise.all(workers);

    const results: EvalCaseResult[] = cases.map((item, idx) => {
        const caseRuns = attemptResults[idx];
        const pass = caseRuns.every(r => r.pass);
        const durationMs = caseRuns.reduce((sum, r) => sum + r.durationMs, 0);
        return {
            file: item.file,
            name: item.evalCase.name,
            pass,
            runs: caseRuns,
            durationMs,
        };
    });

    const passed = results.filter(r => r.pass).length;
    const failed = results.length - passed;
    return {
        pass: failed === 0,
        total: results.length,
        passed,
        failed,
        results,
        durationMs: Date.now() - suiteStart,
    };
}
