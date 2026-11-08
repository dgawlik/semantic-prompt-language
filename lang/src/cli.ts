#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';
import type { Program } from './ast.js';
import { AiBackend } from './ai.js';
import { AuthError, login, logout, parseProvider, type Provider } from './auth.js';
import { Failure, SplSyntaxError } from './errors.js';
import { LlmError, type LlmBackend } from './llm.js';
import { Logger, type LogLevel } from './logger.js';
import { parseMarkdown } from './markdown.js';
import { run, type RunResult } from './interpreter.js';
import { JsonFileStore, MemoryStore, loadStoreModule, type VariableStore } from './store.js';
import { encodeJson, fromJson, newDict, runtimeError, toJson } from './values.js';
import { loadMcpConfig, type McpServers } from './mcp.js';
import { RecordingBackend, ReplayBackend, TraceBackend } from './recording.js';
import { Checkpoint, CheckpointError, checkpointFingerprint } from './checkpoint.js';
import { CliLogging, canInteract } from './cli-logging.js';
import { formatEvent, sanitize, terminalColor } from './log-format.js';
import { Pin } from './pin.js';

const HELP = `spl - Semantic Prompt Language interpreter

Usage: spl <workflow.md> [options]
       spl login <provider>    configure an API key and default provider: openai | anthropic | google
       spl logout [provider]   remove saved credentials (environment variables are unchanged)

Options:
  --log-level <level>     error | info | debug (default: info). Logs go to stderr.
                          All levels include model input/output and variable-state changes.
                          State logs identify defining scopes and before/after values.
                          No source traces, reads, no-op assignments or baseline dumps.
                          Icons: -> input (magenta), <- output (cyan), ~ state (yellow),
                          x error (red), ! warning (yellow), i info (blue), . debug (gray).
                          Interactive JSON starts folded: Up/Down select, Enter/Space toggle,
                          PgUp/PgDn scroll, Home/End reach ends. Exit never waits for a key.
                          Model responses stream live in the interactive view.
                          Plain/final transcripts expand JSON with two-space indentation.
                          NO_COLOR wins over FORCE_COLOR; FORCE_COLOR=0 disables color.
  --silent                suppress all logs; only the result is printed
  --model <id>            model override (takes precedence over frontmatter)
  --provider <name>       openai | anthropic | google; model IDs may use provider/model
  --arg <value>           script argument exposed in $args (repeatable; also --arg=value)
  --human <answer>        answer a human question without prompting (repeatable, in question order)
                          Remaining questions read one line from stdin; prompts go to stderr.
  --mcp <file.json>       MCP servers in VS Code mcp.json format
  --store <file.json>     persist top-level variables in a JSON file
  --store-module <path>   custom variable store: module exporting createStore() -> { load(), save(vars) }
  --timeout <seconds>     per LLM call timeout (default: 300)
  --trace <file.jsonl>    trace all LLM requests, responses, and failures (new file)
  --record <file.jsonl>   record generation responses (new file; no agents)
  --replay <file.jsonl>   replay LLM results without model providers/MCP; explicit script tools still run
                          Legacy --record files allow only local reads and no stores.
  --pin                   on success, save <workflow>.locked.md with responses in double blockquotes
                          Locked workflows replay without models, tools, stores or human prompts.
  --checkpoint <file>    start a new resumable run; with --resume, continue that journal
                          New runs never overwrite an existing file.
  --resume [file]        inspect pending input, or resume with an answer
                          Omit file when using --checkpoint <file>.
  --answer-for <id>      ID of the pending human request being answered
  --answer <text>        exact free-text answer (requires --resume and --answer-for)
  --answer-file <file>   read the answer from a UTF-8 file instead of --answer
  --cwd <dir>             base directory for relative paths and restrictions (default: current directory)
  --check                 validate script syntax and any --mcp config without executing
  -v, --version           print version
  -h, --help              print this help

Provider environment:
  OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY
  Google aliases: GOOGLE_API_KEY, GEMINI_API_KEY (canonical name wins).
  SPL_PROVIDER selects a default; SPL_HOME overrides the saved-credentials folder.
  Environment keys override saved keys. Login configures API keys, not OAuth.

The script result (the value of 'success' or 'return', or the failure payload) is written to stdout.
Normal runs ask for human input directly, even with --silent.
Resumable runs print JSON envelopes and never read stdin.
Exit codes: 0 success, 1 uncaught script failure, 2 syntax or usage error,
3 waiting for human input, 70 internal/infrastructure error.`;

function version(): string {
    const pkg = new URL('../package.json', import.meta.url);
    return (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version: string }).version;
}

function usageError(msg: string): never {
    new Logger('error').error(`spl: ${msg}\nTry 'spl --help'.`);
    process.exit(2);
}

interface CheckpointCliOptions {
    provider?: string;
    checkpoint?: string;
    resume?: string;
    'answer-for'?: string;
    answer?: string;
    'answer-file'?: string;
    model?: string;
    arg?: string[];
    timeout?: string;
}

async function checkpointCommand(
    source: string, program: Program, values: CheckpointCliOptions,
    cwd: string, logger: Logger, mcpServers: McpServers | undefined,
): Promise<number> {
    let checkpoint: Checkpoint | undefined;
    try {
        const directory = fileURLToPath(new URL('.', import.meta.url));
        const runtime = checkpointFingerprint([
            version(), process.version,
            ...fs.readdirSync(directory).filter((name) => name.endsWith('.js')).sort()
                .map((name) => [name, fs.readFileSync(path.join(directory, name), 'utf8')]),
        ]);
        const context = {
            source, runtime, cwd, args: values.arg,
            configuration: { model: values.model ?? null, provider: values.provider ?? null, mcp: mcpServers ?? null },
        };
        checkpoint = values.resume !== undefined
            ? Checkpoint.resume(values.resume, context)
            : Checkpoint.create(values.checkpoint!, context);
        if (values.resume !== undefined) {
            if (values.answer === undefined && values['answer-file'] === undefined) {
                const envelope = { status: 'waiting_for_input', ...checkpoint.request };
                checkpoint.close();
                process.stdout.write(JSON.stringify(envelope) + '\n');
                return 3;
            }
            let answer = values.answer;
            if (values['answer-file'] !== undefined) {
                try {
                    answer = fs.readFileSync(values['answer-file'], 'utf8');
                } catch (error) {
                    throw new CheckpointError(`cannot read answer file: ${(error as Error).message}`);
                }
            }
            checkpoint.answer(values['answer-for']!, answer!);
        }
        const backend = new AiBackend({ logger, cwd, timeoutMs: Number(values.timeout ?? 300) * 1000, mcpServers,
            provider: values.provider ? parseProvider(values.provider) : undefined });
        let result: RunResult;
        try {
            result = await run(program, { backend, logger, cwd, model: values.model, checkpoint });
        } finally {
            await backend.close();
        }
        if (result.status === 'waiting_for_input') {
            checkpoint.close();
            process.stdout.write(JSON.stringify({ status: result.status, ...result.request }) + '\n');
            return 3;
        }
        checkpoint.finish(result.status);
        const envelope = result.status === 'success'
            ? newDict([['status', result.status], ['run_id', checkpoint.runId], ['has_value', result.hasValue], ['value', result.value]])
            : newDict([['status', result.status], ['run_id', checkpoint.runId], ['failure', fromJson(result.failure)]]);
        checkpoint.close();
        process.stdout.write(encodeJson(envelope) + '\n');
        return result.status === 'success' ? 0 : 1;
    } catch (error) {
        if (!(error instanceof CheckpointError) || error.kind !== 'usage') throw error;
        new Logger('error').error(`spl: ${error.message}`);
        return 2;
    } finally {
        checkpoint?.close();
    }
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

async function main(): Promise<number> {
    let parsed;
    let resumeWithCheckpoint = false;
    try {
        const options = {
            'log-level': { type: 'string' },
            silent: { type: 'boolean' },
            model: { type: 'string' },
            provider: { type: 'string' },
            arg: { type: 'string', multiple: true },
            human: { type: 'string', multiple: true },
            mcp: { type: 'string' },
            store: { type: 'string' },
            'store-module': { type: 'string' },
            timeout: { type: 'string' },
            trace: { type: 'string' },
            record: { type: 'string' },
            replay: { type: 'string' },
            pin: { type: 'boolean' },
            checkpoint: { type: 'string' },
            resume: { type: 'string' },
            'answer-for': { type: 'string' },
            answer: { type: 'string' },
            'answer-file': { type: 'string' },
            cwd: { type: 'string' },
            check: { type: 'boolean' },
            version: { type: 'boolean', short: 'v' },
            help: { type: 'boolean', short: 'h' },
        } as const;
        const args = process.argv.slice(2);
        // parseArgs has no optional string options; locate bare --resume using tokens.
        const { tokens } = parseArgs({
            args, options: { ...options, resume: { type: 'boolean' } },
            allowPositionals: true, strict: false, tokens: true,
        });
        const checkpointHasScript = tokens.some((token) => token.kind === 'option' && token.name === 'checkpoint')
            && tokens.filter((token) => token.kind === 'positional').length === 1;
        const bareResume = new Set(tokens
            .filter((token) => token.kind === 'option' && token.name === 'resume'
                && token.value === undefined
                && (checkpointHasScript || args[token.index + 1] === undefined || args[token.index + 1].startsWith('-')))
            .map((token) => token.index));
        resumeWithCheckpoint = bareResume.size > 0;
        parsed = parseArgs({
            args: args.filter((_, index) => !bareResume.has(index)),
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
    let provider: Provider | undefined;
    try { provider = values.provider === undefined ? undefined : parseProvider(values.provider); }
    catch (error) { return usageError((error as Error).message); }
    if (positionals[0] === 'login' || positionals[0] === 'logout') {
        if (positionals.length > 2 || (positionals[1] !== undefined && provider !== undefined)) {
            usageError(`use '${positionals[0]} [provider]' or '${positionals[0]} --provider <name>'`);
        }
        try { provider ??= positionals[1] === undefined ? undefined : parseProvider(positionals[1]); }
        catch (error) { return usageError((error as Error).message); }
        if (positionals[0] === 'login' && !provider) usageError('login requires a provider: openai, anthropic, or google');
        return positionals[0] === 'login' ? loginCommand(provider!) : logoutCommand(provider);
    }
    if (positionals.length !== 1) usageError('expected exactly one script file');

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
    if (values.store && values['store-module']) usageError('--store and --store-module are mutually exclusive');
    if ([values.trace, values.record, values.replay].filter((value) => value !== undefined).length > 1) {
        usageError('--trace, --record, and --replay are mutually exclusive');
    }
    if ([values.trace, values.record, values.replay].some((value) => value !== undefined && value.trim() === '')) {
        usageError('--trace, --record, and --replay require a non-empty file path');
    }
    if (resumeWithCheckpoint) {
        if (values.resume !== undefined) usageError('use either --resume <file> or --resume --checkpoint <file>');
        if (values.checkpoint === undefined) usageError('--resume requires a file: use --resume <file> or --resume --checkpoint <file>');
        values.resume = values.checkpoint;
        delete values.checkpoint;
    }
    const resumable = values.checkpoint !== undefined || values.resume !== undefined;
    if (values.pin && (resumable || values.trace !== undefined || values.record !== undefined || values.replay !== undefined)) {
        usageError('--pin cannot be combined with --checkpoint, --resume, --trace, --record, or --replay');
    }
    if (resumable && values.human !== undefined) usageError('--human cannot be combined with --checkpoint or --resume; use --answer when resuming');
    if (values.checkpoint !== undefined && values.resume !== undefined) usageError('--checkpoint and --resume are mutually exclusive');
    if ([values.checkpoint, values.resume, values['answer-for'], values['answer-file']].some((value) => value !== undefined && !value.trim())) {
        usageError('checkpoint, resume, answer-for, and answer-file require non-empty values');
    }
    if (resumable && [values.store, values['store-module'], values.trace, values.record, values.replay].some((value) => value !== undefined)) {
        usageError('resumable runs cannot use --store, --store-module, --trace, --record, or --replay');
    }
    const answering = values.answer !== undefined || values['answer-file'] !== undefined;
    if (values.answer !== undefined && values['answer-file'] !== undefined) usageError('--answer and --answer-file are mutually exclusive');
    if ((answering || values['answer-for'] !== undefined) && values.resume === undefined) usageError('answer flags require --resume');
    if (answering !== (values['answer-for'] !== undefined)) usageError('an answer requires --answer-for, and --answer-for requires an answer');

    const cwd = path.resolve(values.cwd ?? process.cwd());
    const file = positionals[0];
    if (!/\.md$/i.test(file)) usageError('only .md workflows are executable; wrap SPL in a fenced spl block and add extension/version frontmatter');
    let source: string;
    try {
        source = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return usageError(`cannot read '${file}': ${(e as Error).message}`);
    }

    let program;
    try {
        program = parseMarkdown(source);
    } catch (e) {
        if (e instanceof SplSyntaxError) {
            new Logger('error').error(e.format(file));
            return 2;
        }
        throw e;
    }
    const locked = program.markdown?.lock !== undefined;
    if (/\.locked\.md$/i.test(file) && !locked) usageError('locked workflow is missing its execution journal');
    if (locked && (values.pin || resumable || [values.trace, values.record, values.replay, values.store, values['store-module'], values.mcp, values.human]
        .some(value => value !== undefined))) {
        usageError('locked workflows cannot use --pin, checkpoint/resume, trace/record/replay, stores, --mcp, or --human');
    }
    const lockedFile = file.replace(/\.md$/i, '.locked.md');
    if (values.pin && !values.check && fs.existsSync(lockedFile)) {
        usageError(`cannot pin: '${lockedFile}' already exists; move or remove it first`);
    }
    let mcpServers: McpServers | undefined;
    try {
        mcpServers = values.mcp ? loadMcpConfig(values.mcp, cwd) : undefined;
    } catch (e) {
        return usageError((e as Error).message);
    }
    if (values.check) return 0;
    if (resumable) return checkpointCommand(source, program, values, cwd, logger, mcpServers);

    let backend: LlmBackend;
    try {
        if (locked) backend = {
            async call() { throw new LlmError('locked workflows cannot call a model'); },
            async close() {},
        };
        else if (values.replay) backend = new ReplayBackend(values.replay);
        else {
            backend = new AiBackend({ logger, cwd, timeoutMs: timeoutSec * 1000, mcpServers, provider });
            if (values.record) backend = new RecordingBackend(backend, values.record);
            if (values.trace) backend = new TraceBackend(backend, values.trace);
        }
    } catch (e) {
        if (!(e instanceof Error)) throw e;
        return usageError(`cannot open recording: ${e.message}`);
    }
    if (backend.mode === 'replay' && (values.store || values['store-module'])) {
        return usageError('--replay of legacy --record files cannot use a persistent variable store');
    }
    let store: VariableStore;
    try {
        store = values.store ? new JsonFileStore(values.store) : values['store-module'] ? await loadStoreModule(values['store-module']) : new MemoryStore();
    } catch (e) {
        return usageError((e as Error).message);
    }
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
                await presentation!.close('cancelled');
                process.exit(130);
            }
        })();
    };
    let initialVariables: ReturnType<VariableStore['load']>;
    try { initialVariables = store.load(); }
    catch (error) {
        try { await closeBackend(); }
        catch (closeError) { logger.error(`could not close backend: ${closeError instanceof Error ? closeError.message : String(closeError)}`); }
        throw error;
    }
    const executionStore: VariableStore = { load: () => initialVariables, save: variables => store.save(variables) };
    const pin = values.pin ? Pin.capture(source, { cwd, args: values.arg ?? [], model: values.model }) : undefined;
    presentation = new CliLogging({
        interactive: !values.silent && canInteract(),
        cancel: interrupt,
    });
    const human = async (question: string): Promise<string> => {
        if (values.human !== undefined && suppliedAnswers < values.human.length) {
            return values.human[suppliedAnswers++];
        }
        await presentation!.usePlain();
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
        if (answer.done) throw runtimeError('cannot read human input: stdin ended; supply an answer with --human');
        return answer.value;
    };
    process.on('SIGINT', interrupt);
    await presentation.start();
    try {
        try {
            result = await run(program, {
                backend, logger, store: backend.mode === 'replay' || locked ? undefined : executionStore,
                cwd: locked && values.cwd === undefined ? undefined : cwd,
                model: values.model, args: values.arg, human, pin,
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
    } finally {
        input?.close();
        if (input) process.stdin.pause();
        await presentation.close(interrupted ? 'cancelled' : result?.status === 'success' ? 'completed' : 'failed');
        process.off('SIGINT', interrupt);
    }
    if (interrupted) return 130;
    if (result.status === 'failure') {
        process.stdout.write(JSON.stringify(result.failure, null, 4) + '\n');
        return 1;
    }
    if (result.status === 'waiting_for_input') throw new CheckpointError('unexpected human suspension without a checkpoint', 'infrastructure');
    if (pin) {
        try {
            fs.writeFileSync(lockedFile, pin.toMarkdown(source), { flag: 'wx', mode: 0o600 });
        } catch (error) {
            new Logger('error').error(`spl: cannot save pinned workflow '${lockedFile}': ${error instanceof Error ? error.message : String(error)}`);
            return 70;
        }
    }
    if (result.hasValue) {
        const v = result.value;
        process.stdout.write((typeof v === 'string' ? v : encodeJson(v, 2)) + '\n');
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
