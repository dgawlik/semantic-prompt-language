import { Failure, SuccessSignal, type FailurePayload } from './errors.js';
import { missingImport, provideModules } from './imports.js';
import * as packageModule from './index.js';
import * as markdownModule from './markdown-lib.js';
import { attachWorkspace, library } from './library.js';
import type { LlmBackend } from './llm.js';
import type { Logger } from './logger.js';
import type { Workflow } from './markdown.js';
import { runNatural } from './natural.js';
import { Pin, PinError } from './pin.js';
import { isToolValue } from './recording.js';
import { Runtime, type HumanHandler } from './runtime.js';
import { MemoryStore, type VariableStore } from './store.js';
import { TraceError, type Trace } from './trace.js';
import { Workspace } from './workspace.js';

export interface RunOptions {
    backend: LlmBackend;
    logger: Logger;
    /** Optional initial bindings and final snapshot for embedding hosts. */
    store?: VariableStore;
    /** Working directory for imports, relative paths, `restrict` folders and tools. */
    cwd?: string;
    /** Overrides the frontmatter and per-call models. */
    model?: string;
    /** Script arguments exposed as the read-only `args`; defaults to an empty list. */
    args?: readonly string[];
    trace?: Trace;
    /** Capture a successful workflow for deterministic Markdown replay. */
    pin?: Pin;
    /** Answers `human()` and blockquote `ask_human` calls without suspending. */
    human?: HumanHandler;
    /** Source URI reported in failure payloads, so a host can locate errors across interactive cells. */
    source?: string;
    sourceVersion?: number;
    /** Path of the workflow document: names generated-code caches. Not added to failure payloads. */
    file?: string;
}

export type RunResult =
    | { status: 'success'; value: unknown; hasValue: boolean }
    | { status: 'failure'; failure: FailurePayload };

let anonymous = 0;

// `import ... from 'spl-lang'` in workflow code and helper modules resolves to this running copy.
provideModules({ 'spl-lang': packageModule, 'spl-lang/markdown': markdownModule });

async function execute(workflow: Workflow, opts: RunOptions, workspace: Workspace, interactive: boolean): Promise<RunResult> {
    const { logger, trace, pin } = opts;
    const store = opts.store ?? new MemoryStore();
    const runtime = new Runtime({
        backend: opts.backend, logger, cwd: opts.cwd, model: opts.model, defaultModel: workflow.model,
        args: opts.args, trace, pin, human: opts.human, markdown: workflow.markdown, source: opts.file ?? opts.source,
        sources: workspace.sources,
    });
    attachWorkspace(runtime, workspace);
    // The engine reports this name in stack traces; it maps frames back to document lines.
    // Edited cells get a new name per version, so stale closures never point into newer text.
    const file = opts.source !== undefined
        ? opts.sourceVersion !== undefined ? `${opts.source}@${opts.sourceVersion}` : opts.source
        : opts.file ?? `spl-workflow-${++anonymous}.md`;
    runtime.sources.set(file, { lines: workflow.lines, uri: opts.source, version: opts.sourceVersion });
    let executing = false;
    let current: { line: number; command: string } | undefined;
    try {
        if (trace && opts.store) throw new TraceError('trace runs cannot use a variable store');
        trace?.validateSource(workflow.lines.join('\n'), opts.args);
        const stored = (value: unknown): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isToolValue);
        const variables = pin ? await pin.effect({ kind: 'store' }, () => store.load(), stored) : store.load();
        for (const [name, value] of Object.entries(variables)) workspace.scope[name] = value;
        // Bound after the store loads, so stored variables count as existing state, not as changes.
        workspace.bind(runtime);
        executing = true;
        let last: unknown;
        await runtime.run(async () => {
            for (const step of workflow.steps) {
                current = { line: step.line, command: (workflow.lines[step.line - 1] ?? '').trim() };
                last = undefined;
                if (step.kind === 'code') last = await workspace.execute(step.cell, file, runtime);
                else await runNatural(step, workspace, runtime.root);
            }
        });
        trace?.assertConsumed();
        if (interactive && last !== undefined) return { status: 'success', value: last, hasValue: true };
        return { status: 'success', value: null, hasValue: false };
    } catch (error) {
        if (error instanceof SuccessSignal) {
            trace?.assertConsumed();
            return { status: 'success', value: error.value, hasValue: true };
        }
        if (error instanceof TraceError || error instanceof PinError) throw error;
        const failure = runtime.failure(error, current && { ...current, uri: opts.source, version: opts.sourceVersion });
        failure.source ??= opts.source;
        failure.sourceVersion ??= opts.sourceVersion;
        trace?.assertConsumed();
        logger.error(`${failure.statusCode}: ${failure.reason} (line ${failure.line})`);
        return { status: 'failure', failure: failure.payload() };
    } finally {
        try {
            if (executing && !interactive && !trace && !pin?.replaying) {
                const snapshot: Record<string, unknown> = {};
                for (const [name, value] of Object.entries(workspace.scope)) {
                    if (value !== undefined && isToolValue(value)) snapshot[name] = value;
                }
                store.save(snapshot);
            }
        } catch (error) {
            logger.error(`could not save variable store: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

/** Runs a workflow once, top to bottom, in a fresh shared scope. */
export async function run(workflow: Workflow, opts: RunOptions): Promise<RunResult> {
    try {
        if (workflow.markdown?.lock && opts.pin) throw new PinError('cannot pin an already locked workflow');
        const pin = opts.pin ?? (workflow.markdown?.lock ? Pin.replay(workflow.markdown.lock) : undefined);
        pin?.validateOptions(opts);
        const result = await execute(workflow, { ...opts, pin }, new Workspace(library()), false);
        pin?.assertConsumed();
        return result;
    } catch (error) {
        if (!(error instanceof PinError)) throw error;
        opts.logger.error(error.message);
        return { status: 'failure', failure: new Failure('runtime_error', error.message).payload() };
    }
}

/** An isolated interactive scope, retaining values and function closures between runs. */
export class ExecutionSession {
    private readonly workspace = new Workspace(library());
    private running = false;

    async run(workflow: Workflow, opts: Omit<RunOptions, 'store' | 'trace' | 'pin'>): Promise<RunResult> {
        if (this.running) throw new Error('an execution session can only run one cell at a time');
        if (workflow.markdown?.lock) throw new PinError('locked workflows must run standalone with run(), not in an execution session');
        this.running = true;
        try {
            return await execute(workflow, opts, this.workspace, true);
        } finally {
            this.running = false;
        }
    }

    /** Names currently bound in the session scope. */
    get bindings(): string[] {
        return Object.keys(this.workspace.scope).filter(name => this.workspace.scope[name] !== undefined);
    }
}

export interface WorkflowProblem {
    line: number;
    column: number;
    message: string;
}

/** Static checks beyond syntax: relative imports must point at existing files. Nothing is executed. */
export function checkWorkflow(workflow: Workflow, cwd: string): WorkflowProblem[] {
    const problems: WorkflowProblem[] = [];
    for (const step of workflow.steps) {
        if (step.kind !== 'code') continue;
        for (const item of step.cell.imports) {
            const missing = missingImport(cwd, item.specifier);
            if (missing) problems.push({ line: item.line, column: item.column, message: `cannot find module '${item.specifier}' (resolved to ${missing})` });
        }
    }
    return problems;
}
