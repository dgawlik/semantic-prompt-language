#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { CopilotBackend } from './copilot.js';
import { AuthError, login, logout } from './auth.js';
import { Failure, SplSyntaxError } from './errors.js';
import { LlmError, type LlmBackend } from './llm.js';
import { Logger, type LogLevel } from './logger.js';
import { parse } from './parser.js';
import { run, type RunResult } from './interpreter.js';
import { JsonFileStore, MemoryStore, loadStoreModule, type VariableStore } from './store.js';
import { toJson } from './values.js';
import { loadMcpConfig, type McpServers } from './mcp.js';
import { RecordingBackend, ReplayBackend } from './recording.js';

const HELP = `spl - Semantic Prompt Language interpreter

Usage: spl <script.spl> [options]
       spl login               authenticate with GitHub Copilot (device flow in the browser)
       spl logout              remove the credentials saved by 'spl login'

Options:
  --log-level <level>     error | info | debug (default: info). Logs go to stderr.
                          All levels include LLM transcripts and [deterministic] statement traces.
  --silent                suppress all logs; only the result is printed
  --model <id>            model override (takes precedence over @{model=...})
  --arg <value>           script argument exposed in $args (repeatable; also --arg=value)
  --mcp <file.json>       MCP servers in VS Code mcp.json format
  --store <file.json>     persist top-level variables in a JSON file
  --store-module <path>   custom variable store: module exporting createStore() -> { load(), save(vars) }
  --timeout <seconds>     per LLM call timeout (default: 300)
  --record <file.jsonl>   record generation responses (new file; no agents)
  --replay <file.jsonl>   offline generation replay; only local reads allowed
  --cwd <dir>             base directory for relative paths and restrictions (default: current directory)
  --check                 validate script syntax and any --mcp config without executing
  -v, --version           print version
  -h, --help              print this help

The script result (the value of 'success' or 'return', or the failure payload) is written to stdout.
Exit codes: 0 success, 1 uncaught script failure, 2 syntax or usage error.`;

function version(): string {
    const pkg = new URL('../package.json', import.meta.url);
    return (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version: string }).version;
}

function usageError(msg: string): never {
    process.stderr.write(`spl: ${msg}\nTry 'spl --help'.\n`);
    process.exit(2);
}

async function loginCommand(): Promise<number> {
    try {
        const status = await login((line) => process.stdout.write(line + '\n'));
        process.stdout.write(`Authenticated with GitHub Copilot${status.login ? ` as ${status.login}` : ''}.\n`);
        return 0;
    } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        process.stderr.write(`spl: login failed: ${e.message}\n`);
        return 1;
    }
}

function logoutCommand(): number {
    try {
        process.stdout.write(logout() ? 'Saved credentials removed.\n' : 'No saved credentials.\n');
        return 0;
    } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        process.stderr.write(`spl: ${e.message}\n`);
        return 1;
    }
}

async function main(): Promise<number> {
    let parsed;
    try {
        parsed = parseArgs({
            allowPositionals: true,
            options: {
                'log-level': { type: 'string' },
                silent: { type: 'boolean' },
                model: { type: 'string' },
                arg: { type: 'string', multiple: true },
                mcp: { type: 'string' },
                store: { type: 'string' },
                'store-module': { type: 'string' },
                timeout: { type: 'string' },
                record: { type: 'string' },
                replay: { type: 'string' },
                cwd: { type: 'string' },
                check: { type: 'boolean' },
                version: { type: 'boolean', short: 'v' },
                help: { type: 'boolean', short: 'h' },
            },
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
    if (positionals[0] === 'login' || positionals[0] === 'logout') {
        if (positionals.length !== 1) usageError(`'${positionals[0]}' takes no arguments`);
        return positionals[0] === 'login' ? loginCommand() : logoutCommand();
    }
    if (positionals.length !== 1) usageError('expected exactly one script file');

    const level = values['log-level'] ?? 'info';
    if (!['error', 'info', 'debug'].includes(level)) usageError(`invalid --log-level '${level}'`);
    const logger = new Logger(values.silent ? 'silent' : (level as LogLevel));

    const timeoutSec = Number(values.timeout ?? 300);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) usageError('--timeout must be a positive number');
    if (values.store && values['store-module']) usageError('--store and --store-module are mutually exclusive');
    if (values.record && values.replay) usageError('--record and --replay are mutually exclusive');
    if (values.replay && (values.store || values['store-module'])) usageError('--replay cannot use a persistent variable store');

    const cwd = path.resolve(values.cwd ?? process.cwd());
    const file = positionals[0];
    let source: string;
    try {
        source = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return usageError(`cannot read '${file}': ${(e as Error).message}`);
    }

    let program;
    try {
        program = parse(source);
    } catch (e) {
        if (e instanceof SplSyntaxError) {
            process.stderr.write(e.format(file) + '\n');
            return 2;
        }
        throw e;
    }
    let mcpServers: McpServers | undefined;
    try {
        mcpServers = values.mcp ? loadMcpConfig(values.mcp, cwd) : undefined;
    } catch (e) {
        return usageError((e as Error).message);
    }
    if (values.check) return 0;

    let store: VariableStore;
    try {
        store = values.store ? new JsonFileStore(values.store) : values['store-module'] ? await loadStoreModule(values['store-module']) : new MemoryStore();
    } catch (e) {
        return usageError((e as Error).message);
    }

    let backend: LlmBackend;
    try {
        if (values.replay) backend = new ReplayBackend(values.replay);
        else {
            backend = new CopilotBackend({ logger, cwd, timeoutMs: timeoutSec * 1000, mcpServers });
            if (values.record) backend = new RecordingBackend(backend, values.record);
        }
    } catch (e) {
        if (!(e instanceof Error)) throw e;
        return usageError(`cannot open recording: ${e.message}`);
    }
    let result: RunResult | undefined;
    try {
        result = await run(program, { backend, logger, store: values.replay ? undefined : store, cwd, model: values.model, args: values.arg });
    } finally {
        try {
            await backend.close();
        } catch (e) {
            if (!(e instanceof LlmError)) throw e;
            logger.error(e.message);
            if (result?.status !== 'failure') result = { status: 'failure', failure: new Failure('llm_error', e.message).payload() };
        }
    }
    if (result.status === 'failure') {
        process.stdout.write(JSON.stringify(result.failure, null, 4) + '\n');
        return 1;
    }
    if (result.hasValue) {
        const v = result.value;
        process.stdout.write((typeof v === 'string' ? v : JSON.stringify(toJson(v), null, 2)) + '\n');
    }
    return 0;
}

main().then(
    (code) => process.exit(code),
    (e) => {
        process.stderr.write(`spl: internal error: ${(e as Error).stack ?? e}\n`);
        process.exit(70);
    },
);
