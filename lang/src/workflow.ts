import type { CompiledCell } from './cell.js';
import { Failure, GoSignal, SuccessSignal, type FailurePayload } from './errors.js';
import { missingImport, provideModules } from './imports.js';
import * as packageModule from './index.js';
import * as markdownModule from './markdown-lib.js';
import { attachWorkspace, library } from './library.js';
import type { LlmBackend } from './llm.js';
import type { Logger } from './logger.js';
import type { Step, Workflow } from './markdown.js';
import { overview as bindingOverview, runNatural } from './natural.js';
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
    /** Awaited before each js/ts block and blockquote runs; the CLI `--debug` stepper pauses here. */
    beforeBlock?: (block: BlockStart) => void | Promise<void>;
}

export interface BlockStart {
    kind: 'code' | 'natural';
    line: number;
    /** `js`, `ts`, `agent` or `codegen`. */
    language: string;
    /** The block as written. */
    source: string;
    /** JSON-shaped snapshot of the shared top-level bindings. */
    variables(): Record<string, unknown>;
}

export type RunResult =
    | { status: 'success'; value: unknown; hasValue: boolean }
    | { status: 'failure'; failure: FailurePayload };

let anonymous = 0;

/** Where each aliased block sits: step indices, with the branch index after each `if`. */
function aliasTargets(steps: readonly Step[], path: readonly number[] = [], targets = new Map<string, readonly number[]>()): Map<string, readonly number[]> {
    steps.forEach((step, index) => {
        if (step.kind === 'if') step.branches.forEach((branch, at) => aliasTargets(branch.steps, [...path, index, at], targets));
        else if (step.kind === 'while') aliasTargets(step.steps, [...path, index], targets);
        else if (step.alias) targets.set(step.alias, [...path, index]);
    });
    return targets;
}

// `import ... from 'spl-lang'` in workflow code and helper modules resolves to this running copy.
provideModules({ 'spl-lang': packageModule, 'spl-lang/markdown': markdownModule });

async function execute(workflow: Workflow, opts: RunOptions, workspace: Workspace, interactive: boolean): Promise<RunResult> {
    const { logger, trace, pin } = opts;
    const store = opts.store ?? new MemoryStore();
    const targets = aliasTargets(workflow.steps);
    const runtime = new Runtime({
        backend: opts.backend, logger, cwd: opts.cwd, model: opts.model, defaultModel: workflow.model,
        args: opts.args, trace, pin, human: opts.human, markdown: workflow.markdown, source: opts.file ?? opts.source,
        sources: workspace.sources, aliases: targets.keys(),
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
        const snapshot = (): Record<string, unknown> => ({ ...bindingOverview(workspace).bindings });
        const test = async (condition: CompiledCell, line: number): Promise<boolean> => {
            current = { line, command: (workflow.lines[line - 1] ?? '').trim() };
            last = undefined;
            return Boolean(await workspace.execute(condition, file, runtime));
        };
        // `resume` is the path of a `go()` target: the first index picks a step, and an `if` or
        // `while` on that path is entered at the target instead of testing its condition first.
        const perform = async (steps: readonly Step[], resume: readonly number[] = []): Promise<void> => {
            const [start = 0, ...inner] = resume;
            for (let index = start; index < steps.length; index++) {
                const step = steps[index];
                const within = index === start ? inner : [];
                if (step.kind === 'if') {
                    if (within.length) {
                        const [branch, ...rest] = within;
                        await perform(step.branches[branch].steps, rest);
                        continue;
                    }
                    for (const branch of step.branches) {
                        if (branch.condition && !await test(branch.condition, branch.line)) continue;
                        await perform(branch.steps);
                        break;
                    }
                    continue;
                }
                if (step.kind === 'while') {
                    if (within.length) await perform(step.steps, within);
                    while (await test(step.condition, step.line)) await perform(step.steps);
                    continue;
                }
                current = { line: step.line, command: (workflow.lines[step.line - 1] ?? '').trim() };
                last = undefined;
                if (opts.beforeBlock) {
                    await opts.beforeBlock(step.kind === 'code'
                        ? { kind: 'code', line: step.line, language: step.cell.language, source: step.cell.source, variables: snapshot }
                        : { kind: 'natural', line: step.line, language: step.codegen ? 'codegen' : 'agent', source: step.text, variables: snapshot });
                }
                if (step.kind === 'code') last = await workspace.execute(step.cell, file, runtime);
                else await runNatural(step, workspace, runtime.root);
            }
        };
        await runtime.run(async () => {
            let resume: readonly number[] = [];
            for (;;) {
                try {
                    await perform(workflow.steps, resume);
                    return;
                } catch (error) {
                    if (!(error instanceof GoSignal)) throw error;
                    const target = targets.get(error.alias);
                    if (!target) throw new Failure('runtime_error', `go(): no block has the alias '${error.alias}'`);
                    if (!runtime.replaying) logger.info(`go: continuing at '${error.alias}' (line ${current?.line ?? 0})`);
                    resume = target;
                }
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
    const check = (steps: readonly Step[]): void => {
        for (const step of steps) {
            if (step.kind === 'if') for (const branch of step.branches) check(branch.steps);
            else if (step.kind === 'while') check(step.steps);
            else if (step.kind === 'code') {
                for (const item of step.cell.imports) {
                    const missing = missingImport(cwd, item.specifier);
                    if (missing) problems.push({ line: item.line, column: item.column, message: `cannot find module '${item.specifier}' (resolved to ${missing})` });
                }
            }
        }
    };
    check(workflow.steps);
    return problems;
}
