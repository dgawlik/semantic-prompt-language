#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';
import { AiBackend } from './ai.js';
import { AuthError, login, logout, parseProvider, parseProviderId, type Provider, type ProviderId } from './auth.js';
import { Failure, SplSyntaxError } from './errors.js';
import { LlmError, type LlmBackend } from './llm.js';
import { Logger, type LogLevel } from './logger.js';
import { check } from './check.js';
import { compile } from './compile.js';
import { documentHtml, documentMarkdown } from './doc.js';
import { EvalUsageError, discoverEvalFiles, runEvals } from './eval.js';
import { library } from './library.js';
import { run, type RunResult } from './workflow.js';
import { loadMcpConfig, type McpServers } from './mcp.js';
import { Trace, TraceError, fingerprint } from './trace.js';
import { traceHtml, tracePaths } from './trace-html.js';
import { CliLogging, canInteract } from './cli-logging.js';
import { formatEvent, sanitize, terminalColor } from './log-format.js';

const HELP = `spl - Semantic Prompt Language: natural-language instructions for models and agents, interleaved with TypeScript

Usage: spl run <file.spl> [options]       compile in memory and run in place
       spl eval [paths...] [options]      discover and run *.eval.spl evaluations
       spl check <file.spl>               scan and type-check with tsc, without running
       spl compile <file.spl>             write an importable TypeScript module beside the file
       spl doc <file.spl> [--format md|html]
                                          print documentation: Markdown by default
       spl login <provider>               configure an API key and default provider: openai | anthropic | google
       spl logout [provider]              remove saved credentials (environment variables are unchanged)

Options for run:
  --log-level <level>     error | info | debug (default: info). Logs go to stderr.
                          All levels include model input/output; info adds tool calls;
                          debug adds state changes of block outputs and top-level variables.
                          Icons: -> input (magenta), <- output (cyan), * tool (green), ~ state (yellow),
                          x error (red), ! warning (yellow), i info (blue), . debug (gray).
                          In a terminal, logs show in a full-screen view on stderr. Preambles, JSON,
                          generated code and file/web tool content start collapsed; shell output starts
                          expanded: Up/Down select, Space/Enter expand, PgUp/PgDn scroll, Home/End reach ends.
                          Model responses stream live; human questions are answered in the view.
                          When the run ends, press e to exit: the screen is restored and only
                          the result is printed on stdout.
                          Redirected logs are plain, append-only and fully expanded.
                          NO_COLOR wins over FORCE_COLOR; FORCE_COLOR=0 disables color.
  --silent                suppress all logs; only the result is printed
  --debug                 step through the workflow in the terminal view: stops before each --- block
                          and each top-level statement; n runs the next step, v shows the top-level
                          variables, c continues to the end, e exits immediately. Needs a terminal.
  --model <id>            model override (takes precedence over file defaults and block settings)
  --provider <name>       openai | anthropic | google | openai-compatible; model IDs may use provider/model
  --base-url <url>        custom base URL for the selected provider (or openai-compatible server)
  --retries <N>           retry transient 429/5xx/network errors up to N times with backoff (default: 0)
  --max-steps <N>         maximum model turns per agent call
  --arg <value>           script argument exposed in args (repeatable; also --arg=value)
  --human <answer>        answer a human question without prompting (repeatable, in question order)
                          Remaining questions are asked in the terminal view, or read one line
                          from stdin when logs are redirected; prompts go to stderr.
  --mcp <file.json>       MCP servers in VS Code mcp.json format
  --timeout <seconds>     per LLM call timeout (default: 300)
  --trace <name>          write execution trace to <name>.jsonl and an HTML report to <name>.html
                          (<name>.jsonl is also accepted). Reuse the same path to resume; completed runs
                          replay without external work. Choose another trace name to restart.
  --cwd <dir>             base directory for relative paths and restrictions (default: current directory)

Other options:
  --format <md|html>      output of spl doc (default: md)
  -g, --filter <pattern>  filter evals by description (spl eval)
  --runs <N>              repeat each eval N times; all must pass (default: 1)
  --concurrency <N>       max concurrent evals (default: 1)
  --judge-model <model>   override model used by judge.faithful
  --json                  emit machine-readable JSON results (spl eval)
  -v, --version           print version
  -h, --help              print this help

Provider environment:
  OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY
  Google aliases: GOOGLE_API_KEY, GEMINI_API_KEY (canonical name wins).
  SPL_PROVIDER selects a default; SPL_HOME overrides the saved-credentials folder.
  Environment keys override saved keys. Login configures API keys, not OAuth.

A .spl file is TypeScript with three additions. //* ... *// is a Markdown comment. A --- block holds an
instruction for a model: an optional header of key: value lines (mode, model, reasoning, outputVar, ...),
then the text, where @name reads a variable and, in agent blocks, ->[Type] @name declares an output.
The library (ask, agent, human, restrict, enforce, forbid, success, fail, Str, Int, Struct, ...) needs no import.
Node.js strips the types; spl check type-checks them.

The script result (the value passed to success(), or the failure payload) is written to stdout.
Normal runs ask for human input directly, even with --silent.
Exit codes: 0 success, 1 uncaught script failure, 2 syntax, type or usage error,
70 internal/infrastructure error.`;

function version(): string {
    const pkg = new URL('../package.json', import.meta.url);
    return (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version: string }).version;
}

function usageError(msg: string): never {
    new Logger('error').error(`spl: ${msg}\nTry 'spl --help'.`);
    process.exit(2);
}

async function readApiKey(provider: Provider): Promise<string> {
    process.stderr.write(`${provider} API key (input hidden): `);
    const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const input = createInterface({ input: process.stdin, output: muted, terminal: Boolean(process.stdin.isTTY) });
    try {
        return await new Promise<string>((resolve, reject) => {
            let answered = false;
            input.on('SIGINT', () => reject(new AuthError('login cancelled')));
            input.on('close', () => { if (!answered) reject(new AuthError('stdin ended before an API key was supplied')); });
            input.question('', key => { answered = true; resolve(key); });
        });
    } finally {
        input.close();
        muted.end();
        process.stderr.write('\n');
    }
}

async function loginCommand(provider: Provider): Promise<number> {
    try {
        const status = await login(provider, () => readApiKey(provider));
        process.stdout.write(`Configured ${status.provider} using ${status.source}. Default provider: ${status.provider}.\n`);
        return 0;
    } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        new Logger('error').error(`spl: login failed: ${e.message}`);
        return 1;
    }
}

function logoutCommand(provider?: Provider): number {
    try {
        process.stdout.write(logout(provider) ? 'Saved credentials removed.\n' : 'No saved credentials.\n');
        return 0;
    } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        new Logger('error').error(`spl: ${e.message}`);
        return 1;
    }
}

/** Paths as the user wrote them: relative when inside the current directory. */
const shown = (file: string): string => {
    const relative = path.relative(process.cwd(), file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
};

function readWorkflow(file: string): string {
    if (/\.md$/i.test(file)) usageError(`'${file}': Markdown workflows are no longer executable; SPL 3.0 runs .spl files. See the migration guide`);
    if (!/\.spl$/i.test(file)) usageError(`'${file}' is not a .spl file`);
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (e) {
        return usageError(`cannot read '${file}': ${(e as Error).message}`);
    }
}

/** Runs a command that only reads the workflow; syntax problems are reported like any compiler does. */
function report(file: string, body: () => number): number {
    try {
        return body();
    } catch (e) {
        if (!(e instanceof SplSyntaxError)) throw e;
        new Logger('error').error(e.format(file));
        return 2;
    }
}

function checkCommand(file: string): number {
    readWorkflow(file);
    const problems = check(file);
    for (const problem of problems) new Logger('error').error(`${shown(problem.file)}:${problem.line}:${problem.column}: ${problem.message}`);
    return problems.length ? 2 : 0;
}

/** Writes `<name>.ts` beside the workflow and beside every `.spl` file it imports. */
function compileCommand(file: string): number {
    const pending = [path.resolve(file)];
    const written = new Set<string>();
    while (pending.length) {
        const current = pending.pop()!;
        if (written.has(current)) continue;
        written.add(current);
        const source = readWorkflow(current);
        const code = report(current, () => {
            const compiled = compile(source, { eval: /\.eval\.spl$/i.test(current) });
            for (const item of compiled.imports) {
                if (/^\.{1,2}\/.*\.spl$/.test(item.specifier)) pending.push(path.resolve(path.dirname(current), item.specifier));
            }
            const target = current.replace(/\.spl$/i, '.ts');
            fs.writeFileSync(target, compiled.emit({ library: Object.keys(library()), from: path.basename(current) }));
            process.stdout.write(`${shown(target)}\n`);
            return 0;
        });
        if (code) return code;
    }
    return 0;
}

function docCommand(file: string, format: string): number {
    if (format !== 'md' && format !== 'html') usageError(`invalid --format '${format}'; use md or html`);
    const source = readWorkflow(file);
    return report(file, () => {
        process.stdout.write(format === 'html' ? documentHtml(source, path.basename(file)) : documentMarkdown(source));
        return 0;
    });
}

async function main(): Promise<number> {
    let parsed;
    try {
        const options = {
            'log-level': { type: 'string' },
            silent: { type: 'boolean' },
            model: { type: 'string' },
            provider: { type: 'string' },
            'base-url': { type: 'string' },
            retries: { type: 'string' },
            'max-steps': { type: 'string' },
            arg: { type: 'string', multiple: true },
            human: { type: 'string', multiple: true },
            mcp: { type: 'string' },
            timeout: { type: 'string' },
            trace: { type: 'string' },
            cwd: { type: 'string' },
            debug: { type: 'boolean' },
            format: { type: 'string' },
            filter: { type: 'string', short: 'g' },
            runs: { type: 'string' },
            concurrency: { type: 'string' },
            'judge-model': { type: 'string' },
            json: { type: 'boolean' },
            version: { type: 'boolean', short: 'v' },
            help: { type: 'boolean', short: 'h' },
        } as const;
        parsed = parseArgs({
            args: process.argv.slice(2),
            allowPositionals: true,
            options,
        });
    } catch (e) {
        return usageError((e as Error).message);
    }
    const { values, positionals } = parsed;
    if (values.help) {
        process.stdout.write(HELP + '\n');
        return 0;
    }
    if (values.version) {
        process.stdout.write(version() + '\n');
        return 0;
    }
    let provider: ProviderId | undefined;
    try { provider = values.provider === undefined ? undefined : parseProviderId(values.provider); }
    catch (error) { return usageError((error as Error).message); }
    const baseUrl = values['base-url'];
    if (baseUrl !== undefined && !baseUrl.trim()) usageError('--base-url requires a non-empty URL');
    const maxRetries = values.retries === undefined ? 0 : Number(values.retries);
    if (!Number.isInteger(maxRetries) || maxRetries < 0) usageError('--retries must be a non-negative integer');
    const maxSteps = values['max-steps'] === undefined ? undefined : Number(values['max-steps']);
    if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) usageError('--max-steps must be a positive integer');
    const [command, file] = positionals;
    if (command === 'login' || command === 'logout') {
        if (positionals.length > 2 || (file !== undefined && provider !== undefined)) {
            usageError(`use '${command} [provider]' or '${command} --provider <name>'`);
        }
        let authProvider: Provider | undefined;
        try {
            const raw = provider ?? file;
            authProvider = raw === undefined ? undefined : parseProvider(raw);
        }
        catch (error) { return usageError((error as Error).message); }
        if (command === 'login' && !authProvider) usageError('login requires a provider: openai, anthropic, or google');
        return command === 'login' ? loginCommand(authProvider!) : logoutCommand(authProvider);
    }
    if (command === 'eval') {
        const cwd = path.resolve(values.cwd ?? process.cwd());
        const runs = values.runs === undefined ? 1 : Number(values.runs);
        if (!Number.isInteger(runs) || runs < 1) usageError('--runs must be a positive integer');
        const concurrency = values.concurrency === undefined ? 1 : Number(values.concurrency);
        if (!Number.isInteger(concurrency) || concurrency < 1) usageError('--concurrency must be a positive integer');
        const timeoutSec = Number(values.timeout ?? 300);
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) usageError('--timeout must be a positive number');
        if (values.trace !== undefined && !values.trace.trim()) usageError('--trace requires a non-empty file path');
        const level = values['log-level'] ?? 'error';
        if (!['error', 'info', 'debug'].includes(level)) usageError(`invalid --log-level '${level}'`);
        let mcpServers: McpServers | undefined;
        try {
            mcpServers = values.mcp ? loadMcpConfig(values.mcp, cwd) : undefined;
        } catch (e) {
            return usageError((e as Error).message);
        }
        let files: string[];
        try {
            files = discoverEvalFiles(positionals.slice(1), cwd);
        } catch (e) {
            if (e instanceof EvalUsageError) return usageError(e.message);
            throw e;
        }
        const directory = fileURLToPath(new URL('.', import.meta.url));
        const runtimeFingerprint = fingerprint([version(), process.version,
            ...fs.readdirSync(directory).filter(name => name.endsWith('.js')).sort()
                .map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')])]);
        const logger = new Logger(values.silent || values.json ? 'silent' : (level as LogLevel), undefined, {
            eventSink: event => process.stderr.write(formatEvent(event, terminalColor()) + '\n'),
        });
        try {
            const suite = await runEvals({
                files,
                cwd,
                filter: values.filter,
                runs,
                concurrency,
                model: values.model,
                judgeModel: values['judge-model'],
                maxSteps,
                trace: values.trace,
                runtimeFingerprint,
                traceConfig: { model: values.model ?? null, judgeModel: values['judge-model'] ?? null, provider: values.provider ?? null, mcp: mcpServers ?? null },
                logger,
                backendFactory: log => new AiBackend({ logger: log, cwd, timeoutMs: timeoutSec * 1000, mcpServers, provider, baseUrl, maxRetries, maxSteps }),
            });
            if (values.json) {
                process.stdout.write(JSON.stringify(suite, null, 2) + '\n');
            } else {
                for (const item of suite.results) {
                    const icon = item.pass ? 'PASS' : 'FAIL';
                    const suffix = item.runs.length > 1 ? ` (${item.runs.filter(r => r.pass).length}/${item.runs.length} runs)` : '';
                    process.stdout.write(`${icon} ${shown(item.file)}: ${item.name}${suffix}\n`);
                    if (!item.pass) {
                        for (const run of item.runs) {
                            if (run.error) process.stdout.write(`  run ${run.run}: error: ${run.error}\n`);
                            for (const assertion of run.assertions) {
                                if (!assertion.pass) {
                                    const score = assertion.score !== undefined ? ` (score ${assertion.score})` : '';
                                    process.stdout.write(`  run ${run.run}: ${assertion.judge} failed${score}: ${assertion.reason}\n`);
                                }
                            }
                        }
                    }
                }
                process.stdout.write(`\n${suite.passed}/${suite.total} evals passed (${suite.durationMs} ms)\n`);
            }
            return suite.pass ? 0 : 1;
        } catch (e) {
            if (e instanceof EvalUsageError) return usageError(e.message);
            if (e instanceof SplSyntaxError) {
                new Logger('error').error(e.format(e.file ?? files[0] ?? 'eval'));
                return 2;
            }
            if (e instanceof TraceError && e.kind === 'usage') return usageError(e.message);
            throw e;
        }
    }
    if (command !== 'run' && command !== 'check' && command !== 'compile' && command !== 'doc') {
        usageError(command === undefined ? 'expected a command: run, eval, check, compile, doc, login or logout'
            : /\.(?:spl|md)$/i.test(command) ? `expected a command before the file; to run it, use 'spl run ${command}'`
            : `unknown command '${command}'`);
    }
    if (positionals.length !== 2) usageError(`'spl ${command}' takes exactly one .spl file`);
    if (values.format !== undefined && command !== 'doc') usageError('--format applies only to spl doc');
    if (command === 'check') return checkCommand(file);
    if (command === 'compile') return compileCommand(file);
    if (command === 'doc') return docCommand(file, values.format ?? 'md');
    if (/\.eval\.spl$/i.test(file)) {
        usageError(`'${file}' is an eval file; run it with 'spl eval ${file}'`);
    }

    const level = values['log-level'] ?? 'info';
    if (!['error', 'info', 'debug'].includes(level)) usageError(`invalid --log-level '${level}'`);
    let presentation: CliLogging | undefined;
    const logger = new Logger(values.silent ? 'silent' : (level as LogLevel), undefined, {
        eventSink: event => {
            if (presentation) presentation.sink(event);
            else process.stderr.write(formatEvent(event, terminalColor()) + '\n');
        },
        streamSink: event => presentation?.streamSink(event),
    });

    const timeoutSec = Number(values.timeout ?? 300);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) usageError('--timeout must be a positive number');
    if (values.trace !== undefined && !values.trace.trim()) usageError('--trace requires a non-empty file path');

    const cwd = path.resolve(values.cwd ?? process.cwd());
    const source = readWorkflow(file);
    try {
        compile(source);
    } catch (e) {
        if (!(e instanceof SplSyntaxError)) throw e;
        new Logger('error').error(e.format(file));
        return 2;
    }
    let mcpServers: McpServers | undefined;
    try {
        mcpServers = values.mcp ? loadMcpConfig(values.mcp, cwd) : undefined;
    } catch (e) {
        return usageError((e as Error).message);
    }
    if (values.debug && (values.silent || !canInteract())) {
        usageError('--debug needs an interactive terminal (stdin and stderr) and cannot be combined with --silent');
    }

    const traceTarget = values.trace ? tracePaths(values.trace) : undefined;
    let trace: Trace | undefined;
    try {
        if (traceTarget) {
            const directory = fileURLToPath(new URL('.', import.meta.url));
            trace = Trace.open(traceTarget.jsonl, {
                source, cwd, args: values.arg,
                runtime: fingerprint([version(), process.version,
                    ...fs.readdirSync(directory).filter(name => name.endsWith('.js')).sort()
                        .map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')])]),
                configuration: { model: values.model ?? null, provider: values.provider ?? null, mcp: mcpServers ?? null },
            });
        }
    } catch (e) {
        if (!(e instanceof Error)) throw e;
        if (e instanceof TraceError && e.kind === 'infrastructure') throw e;
        return usageError(`cannot open trace: ${e.message}`);
    }
    const writeTraceHtml = (): void => {
        if (!traceTarget || !fs.existsSync(traceTarget.jsonl)) return;
        const journal = fs.readFileSync(traceTarget.jsonl, 'utf8');
        fs.writeFileSync(traceTarget.html, traceHtml(journal, {
            title: shown(path.resolve(file)), source, traceFile: shown(traceTarget.jsonl),
        }), 'utf8');
    };
    const backend: LlmBackend = new AiBackend({ logger, cwd, timeoutMs: timeoutSec * 1000, mcpServers, provider, baseUrl, maxRetries, maxSteps });
    let result: RunResult | undefined;
    let interrupted = false;
    let input: Interface | undefined;
    let answers: AsyncIterator<string> | undefined;
    let suppliedAnswers = 0;
    let backendClosing: Promise<void> | undefined;
    const closeBackend = () => backendClosing ??= backend.close();
    const interrupt = (): void => {
        if (interrupted) return;
        interrupted = true;
        trace?.cancel();
        input?.close();
        void (async () => {
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([closeBackend(), new Promise<never>((_, reject) => {
                    deadline = setTimeout(() => reject(new Error('backend close timed out during cancellation')), 1_000);
                })]);
            }
            catch (error) { logger.error(`could not close backend: ${error instanceof Error ? error.message : String(error)}`); }
            finally {
                clearTimeout(deadline);
                trace?.close();
                writeTraceHtml();
                await presentation!.close('cancelled');
                process.exit(130);
            }
        })();
    };
    presentation = new CliLogging({
        interactive: !values.silent && canInteract(),
        cancel: interrupt,
        title: file,
        debug: values.debug,
    });
    const human = async (question: string): Promise<string> => {
        if (values.human !== undefined && suppliedAnswers < values.human.length) {
            return values.human[suppliedAnswers++];
        }
        if (presentation!.interactive) {
            try {
                return await presentation!.ask(question);
            } catch (error) {
                throw new Failure('runtime_error', `cannot read human input: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (!input) {
            input = createInterface({
                input: process.stdin, output: process.stderr,
                terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY), crlfDelay: Infinity,
            });
            input.on('SIGINT', interrupt);
            answers = input[Symbol.asyncIterator]();
        }
        process.stderr.write(sanitize(question) + '\n> ');
        const answer = await answers!.next();
        if (answer.done) throw new Failure('runtime_error', 'cannot read human input: stdin ended; supply an answer with --human');
        return answer.value;
    };
    process.on('SIGINT', interrupt);
    await presentation.start();
    let usage: string | undefined;
    try {
        try {
            result = await run(source, {
                backend, logger, trace, file: path.resolve(file), cwd,
                model: values.model, maxSteps, args: values.arg, human,
                beforeStep: values.debug ? async step => { await presentation!.pause(step); } : undefined,
            });
        } finally {
            try {
                await closeBackend();
            } catch (e) {
                if (!(e instanceof LlmError)) throw e;
                logger.error(e.message);
                if (result?.status !== 'failure') result = { status: 'failure', failure: new Failure('llm_error', e.message).payload() };
            }
        }
        if (!interrupted) trace?.finish(result);
    } catch (error) {
        if (interrupted) return 130;
        // A workflow imported by this one may still have syntax problems.
        if (error instanceof SplSyntaxError) usage = error.format(file);
        else if (error instanceof TraceError && error.kind === 'usage') usage = `spl: ${error.message}`;
        else throw error;
    } finally {
        trace?.close();
        if (usage === undefined) writeTraceHtml();
        input?.close();
        if (input) process.stdin.pause();
        // An interactive run that finished keeps its screen until the user presses `e`; nothing is replayed after it closes.
        await presentation.close(interrupted || usage !== undefined || !result ? 'cancelled' : result.status === 'success' ? 'completed' : 'failed');
        process.off('SIGINT', interrupt);
    }
    if (usage !== undefined) {
        new Logger('error').error(usage);
        return 2;
    }
    if (interrupted || !result) return 130;
    if (result.status === 'failure') {
        process.stdout.write(JSON.stringify(result.failure, null, 4) + '\n');
        return 1;
    }
    if (result.hasValue) {
        const v = result.value;
        process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? 'null') + '\n');
    }
    return 0;
}

main().then(
    (code) => process.exit(code),
    (e) => {
        new Logger('error').error(`spl: internal error: ${(e as Error).stack ?? e}`);
        process.exit(70);
    },
);
