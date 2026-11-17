import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Trace, fingerprint } from '../src/trace.js';
import { run as execute } from '../src/workflow.js';
import { agentBlock, backend, block, cleanTemp, save, silent, tempDir } from './helpers.js';

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');
const dist = (name: string): string => pathToFileURL(path.join(path.dirname(CLI), name)).href;
const VERSION = (JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;

/** Credentials and color settings of the developer's shell must not reach the spawned CLI. */
const OFFLINE = {
    OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined,
    GOOGLE_API_KEY: undefined, GEMINI_API_KEY: undefined, SPL_PROVIDER: undefined,
    FORCE_COLOR: undefined, NO_COLOR: undefined,
};

// Every case spawns the real CLI, some of them several times.
vi.setConfig({ testTimeout: 30_000 });

let dir: string;
beforeEach(() => {
    dir = tempDir('spl-cli-');
});
afterEach(() => {
    vi.unstubAllEnvs();
    cleanTemp();
});

const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
const exists = (name: string): boolean => fs.existsSync(path.join(dir, name));
const read = (name: string): string => fs.readFileSync(path.join(dir, name), 'utf8');

function run(args: string[], env: NodeJS.ProcessEnv = {}, input?: string) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8', cwd: dir, input,
        env: { ...process.env, ...OFFLINE, ...env, SPL_HOME: path.join(dir, 'spl-home') },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Writes a file in the test folder, creating its folders, and returns its path. */
function write(name: string, content: string): string {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

/** Runs `.spl` source with `spl run`. */
function spl(source: string, ...args: string[]) {
    return run(['run', write('s.spl', source), ...args]);
}

/** Type-checks `.spl` source with `spl check`. */
function check(source: string, ...args: string[]) {
    return run(['check', write('s.spl', source), ...args]);
}

/** Loads a module into the spawned CLI before it starts, to inject faults without touching the sources. */
function preload(name: string, code: string): { NODE_OPTIONS: string } {
    return { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(write(name, code)).href}` };
}

interface Call { kind: string; model: string | null; reasoning: string | null; prompt: string; tools: number }

/**
 * Replaces the model of the spawned CLI. `respond` is the source of a function `(request, call) => reply`:
 * `call` counts from 1, a reply is text or a whole response, and `act(request, name, args)` uses a tool of an agent block.
 */
function model(respond: string): { NODE_OPTIONS: string } {
    return preload('model.mjs', `import fs from 'node:fs';
import { AiBackend } from ${JSON.stringify(dist('ai.js'))};
const respond = ${respond};
const act = (request, name, args) => request.invokeAction({ name, arguments: args });
let calls = 0;
AiBackend.prototype.call = async function(request) {
    fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({
        kind: request.kind, model: request.model ?? null, reasoning: request.reasoningEffort ?? null,
        prompt: request.prompt, tools: request.runtimeTools?.length ?? 0,
    }) + '\\n');
    const reply = await respond(request, ++calls);
    return typeof reply === 'string' ? { text: reply, effective: {} } : reply;
};
`);
}

/** The requests the fake model received since this was last asked. */
function calls(): Call[] {
    if (!exists('calls.jsonl')) return [];
    const requests = read('calls.jsonl').trim().split('\n').map(line => JSON.parse(line) as Call);
    fs.unlinkSync(path.join(dir, 'calls.jsonl'));
    return requests;
}

describe('commands and usage', () => {
    it('prints help and the package version', () => {
        const help = run(['-h', path.join(dir, 'missing.spl')]);
        expect(help).toMatchObject({ code: 0, err: '' });
        expect(help.out).toMatch(/^spl - Semantic Prompt Language: natural-language instructions for models and agents, interleaved with TypeScript\n\nUsage: spl run <file\.spl> \[options\] +compile in memory and run in place\n/);
        expect(help.out).toContain('Exit codes: 0 success, 1 uncaught script failure, 2 syntax, type or usage error,\n70 internal/infrastructure error.\n');
        expect(run(['run', '--help']).out).toBe(help.out);
        for (const flag of ['--version', '-v']) expect(run([flag])).toEqual({ code: 0, out: `${VERSION}\n`, err: '' });
        expect(VERSION).toBe('3.0.0');
    });

    it('lists the commands, the options of run and the file format in the help', () => {
        const help = run(['--help']).out;
        for (const usage of [
            'spl run <file.spl> [options]', 'spl check <file.spl>', 'spl compile <file.spl>', 'spl doc <file.spl> [--format md|html]',
            'spl login <provider>', 'spl logout [provider]',
        ]) expect(help).toContain(usage);
        for (const option of [
            '--log-level <level>', '--silent', '--debug', '--model <id>', '--provider <name>', '--arg <value>', '--human <answer>',
            '--mcp <file.json>', '--timeout <seconds>', '--trace <name>', '--cwd <dir>', '--format <md|html>',
        ]) expect(help).toContain(`\n  ${option} `);
        expect(help).toContain('debug adds state changes of block outputs and top-level variables.');
        expect(help).toContain('Space/Enter expand');
        expect(help).toContain('press e to exit');
        expect(help).toContain('Redirected logs are plain, append-only and fully expanded');
        expect(help).toContain('--debug                 step through the workflow in the terminal view: stops before each --- block');
        expect(help).toContain('and each top-level statement; n runs the next step, v shows the top-level');
        expect(help).toContain('--arg <value>           script argument exposed in args');
        expect(help).toContain('--cwd <dir>             base directory for relative paths and restrictions');
        expect(help).toContain('--trace <name>');
        expect(help).toContain('<name>.jsonl');
        expect(help).toContain('<name>.html');
        expect(help).toContain('Reuse the same path to resume');
        expect(help).toContain('the value passed to success()');
        expect(help).toContain('A .spl file is TypeScript with three additions.');
        expect(help).toContain('Node.js strips the types; spl check type-checks them.');
        for (const removed of ['--pin', '--check', '--backend', '--seed', '--store', '--record', '--replay', '--checkpoint', '--resume', '--answer',
            '.md', 'locked', 'fence', 'blockquote', 'think', 'no-op assignments', '[deterministic]', '$args']) {
            expect(help).not.toContain(removed);
        }
    });

    it.each([
        ['', 'expected a command: run, check, compile, doc, login or logout'],
        ['s.spl', "expected a command before the file; to run it, use 'spl run s.spl'"],
        ['notes.md', "expected a command before the file; to run it, use 'spl run notes.md'"],
        ['frobnicate s.spl', "unknown command 'frobnicate'"],
        ['script.js', "unknown command 'script.js'"],
        ['run', "'spl run' takes exactly one .spl file"],
        ['run s.spl s.spl', "'spl run' takes exactly one .spl file"],
        ['check', "'spl check' takes exactly one .spl file"],
        ['run notes.md', "'notes.md': Markdown workflows are no longer executable; SPL 3.0 runs .spl files. See the migration guide"],
        ['check NOTES.MD', "'NOTES.MD': Markdown workflows are no longer executable; SPL 3.0 runs .spl files. See the migration guide"],
        ['compile notes.md', "'notes.md': Markdown workflows are no longer executable; SPL 3.0 runs .spl files. See the migration guide"],
        ['run script.js', "'script.js' is not a .spl file"],
        ['run s.spl --format html', '--format applies only to spl doc'],
        ['check s.spl --format=md', '--format applies only to spl doc'],
        ['compile s.spl --format=md', '--format applies only to spl doc'],
        ['doc s.spl --format pdf', "invalid --format 'pdf'; use md or html"],
        ['run s.spl --log-level loud', "invalid --log-level 'loud'"],
        ['run s.spl --timeout=0', '--timeout must be a positive number'],
        ['run s.spl --timeout=soon', '--timeout must be a positive number'],
        ['run s.spl --trace=', '--trace requires a non-empty file path'],
        ['run s.spl --provider nope', "unknown provider 'nope'; expected openai, anthropic, google"],
    ])('rejects `spl %s` as a usage error before doing anything', (line, message) => {
        write('s.spl', "await writeFile('ran.txt', 'x');\nsuccess(42);");
        write('notes.md', '# Notes\n\n```js\nsuccess(42);\n```\n');
        write('script.js', 'success(42);');
        const result = run(line ? line.split(' ') : []);
        // `spl compile` names files by their full path.
        expect({ ...result, err: result.err.replaceAll(dir + path.sep, '') }).toEqual({ code: 2, out: '', err: `x error spl: ${message}\nTry 'spl --help'.\n` });
        expect(fs.readdirSync(dir).sort()).toEqual(['notes.md', 's.spl', 'script.js']);
    });

    it.each(['--pin', '--check', '--store=file', '--store-module=file', '--record=file', '--replay=file', '--checkpoint=file',
        '--resume=file', '--answer-for=id', '--answer=value', '--answer-file=file', '--answre-file=file', '--backend=mock', '--seed=1',
        '--trace', '--arg', '--format'])('rejects removed or invalid option %s', option => {
        const result = spl("await writeFile('ran.txt', 'x');\nsuccess(1);", option, '--silent');
        expect(result).toMatchObject({ code: 2, out: '' });
        expect(result.err).toMatch(/^x error spl: /);
        expect(exists('ran.txt')).toBe(false);
    });

    it('runs only .spl files that exist', () => {
        const missing = run(['run', 'missing.spl']);
        expect(missing).toMatchObject({ code: 2, out: '' });
        expect(missing.err).toMatch(/^x error spl: cannot read 'missing\.spl': ENOENT/);
        for (const command of ['check', 'compile', 'doc']) {
            expect(run([command, path.join(dir, 'missing.spl')])).toMatchObject({ code: 2, out: '', err: expect.stringContaining("spl: cannot read '") });
        }
        // A 2.x block file keeps its extension but not its syntax.
        const legacy = write('legacy.spl', "{js}\nawait writeFile('ran.txt', 'x');\n{/js}");
        expect(run(['run', legacy])).toEqual({
            code: 2, out: '',
            err: `x error ${legacy}:1:1: syntax error: SPL 2.x syntax; see the migration guide\n${legacy}:3:1: syntax error: SPL 2.x syntax; see the migration guide\n`,
        });
        expect(fs.readdirSync(dir)).toEqual(['legacy.spl']);
    });

    it('uses the same log format for CLI usage and syntax diagnostics', () => {
        const usage = run(['--unknown-option'], { NO_COLOR: '1' });
        expect(usage.code).toBe(2);
        expect(usage.out).toBe('');
        expect(usage.err).toMatch(/^x error /);
        expect(usage.err.match(/x error/g)).toHaveLength(1);
        expect(usage.err).toContain("Try 'spl --help'.");
        const syntax = spl('const value =');
        expect(syntax.code).toBe(2);
        expect(syntax.err).toMatch(/^x error /);
        expect(run(['--unknown-option'], { FORCE_COLOR: '1' }).err).toMatch(/^\u001b\[1;31mx error\u001b\[0m /);
    });

    it('requires an interactive terminal for --debug', () => {
        const message = 'spl: --debug needs an interactive terminal (stdin and stderr) and cannot be combined with --silent';
        expect(spl("await writeFile('ran.txt', 'x');\nsuccess(1);", '--debug')).toEqual({ code: 2, out: '', err: `x error ${message}\nTry 'spl --help'.\n` });
        expect(spl("await writeFile('ran.txt', 'x');\nsuccess(1);", '--debug', '--silent')).toMatchObject({ code: 2, out: '', err: expect.stringContaining(message) });
        expect(run(['run', path.join(dir, 's.spl'), '--debug'], {}, 'n\nn\n')).toMatchObject({ code: 2, out: '' });
        expect(exists('ran.txt')).toBe(false);
        // Problems of the file come first: they need no terminal to be reported.
        expect(spl('const value =', '--debug')).toMatchObject({ code: 2, out: '', err: expect.stringContaining('syntax error') });
    });
});

describe('spl run', () => {
    it('runs TypeScript with its types erased, around Markdown comments', () => {
        expect(spl('interface Point { x: number; y: number }\nconst point: Point = { x: 40, y: 2 };\nsuccess(point.x + (point.y as number));', '--silent'))
            .toEqual({ code: 0, out: '42\n', err: '' });
        expect(spl('const base = 40;\n\n//*\n# Sum\n\nProse with a `---` rule is not a block:\n\n***\n*//\n\nconst total: number = base + 2;\n/* --- */ success(total);', '--silent'))
            .toEqual({ code: 0, out: '42\n', err: '' });
        expect(spl('enum Color { Red }\nsuccess(Color.Red);', '--silent')).toMatchObject({ code: 2, out: '', err: expect.stringMatching(/s\.spl:1:1: syntax error: /) });
    });

    it('prints the success value to stdout and logs to stderr', () => {
        const r = spl("log('hi');\nlog.error('bad');\nlog.debug('hidden');\nsuccess('done');");
        expect(r.code).toBe(0);
        expect(r.out).toBe('done\n');
        expect(r.err).toBe('[info] log: hi\n[error] log: bad\n');
    });

    it('prints nothing without success() and rejects a top-level return', () => {
        expect(spl('const a = 41;\na + 1', '--silent')).toEqual({ code: 0, out: '', err: '' });
        expect(spl('success();', '--silent')).toEqual({ code: 0, out: 'null\n', err: '' });
        const returned = spl('const a = 41;\nreturn a + 1;');
        expect(returned).toMatchObject({ code: 2, out: '' });
        expect(returned.err).toMatch(/s\.spl:2:1: syntax error: .*[Rr]eturn/);
    });

    it('prints non-string results as JSON', () => {
        expect(JSON.parse(spl('success({ a: [1, null, true], skipped: undefined, half: 0.5, empty: [] });').out)).toEqual({ a: [1, null, true], half: 0.5, empty: [] });
        expect(spl('success(false);', '--silent').out).toBe('false\n');
    });

    it('pretty-prints and colors JSON logs on stderr without changing stdout', () => {
        const file = write('pretty.spl', "const review = { findings: [{ severity: 'high', line: 12 }] };\nlog('review:', review);\nsuccess(review);");
        const plain = run(['run', file]);
        const colored = run(['run', file], { FORCE_COLOR: '1' });
        expect(plain.code).toBe(0);
        expect(colored.code).toBe(0);
        expect(colored.out).toBe(plain.out);
        expect(JSON.parse(colored.out)).toEqual({ findings: [{ severity: 'high', line: 12 }] });
        expect(colored.out).not.toContain('\u001b[');
        expect(plain.err).not.toContain('\u001b[');
        expect(colored.err).toContain('\u001b[36m"findings"\u001b[0m');
        expect(stripVTControlCharacters(colored.err)).toBe(plain.err);
        expect(plain.err).toContain('[info] log: review:\n{\n  "findings": [');
        expect(run(['run', file, '--silent'], { FORCE_COLOR: '1' }).err).toBe('');
    });

    it.each([
        [undefined, undefined, 'xterm', false], ['1', undefined, 'xterm', true],
        ['0', undefined, 'xterm', false], ['1', '1', 'xterm', false],
        [undefined, undefined, 'dumb', false], ['1', undefined, 'dumb', true],
    ])('keeps redirected output append-only with FORCE_COLOR=%s NO_COLOR=%s TERM=%s', (force, noColor, term, color) => {
        const file = write('colors.spl', "const n = 1;\nlog('hi');\nsuccess(n);");
        const result = run(['run', file], { FORCE_COLOR: force, NO_COLOR: noColor, TERM: term });
        expect(result).toMatchObject({ code: 0, out: '1\n' });
        expect(result.err.includes('\u001b[')).toBe(color);
        expect(result.err.replace(/\u001b\[[\d;]*m/g, '')).not.toContain('\u001b');
        expect(result.err.replace(/\u001b\[[\d;]*m/g, '')).toContain('[info] log: hi\n');
        expect(result.err).not.toContain('Enter/Space');
    });

    it('never loads the terminal UI or acquires input for excluded invocations and library sinks', () => {
        const marker = path.join(dir, 'acquisition.txt');
        const env = {
            TERM: 'xterm', NO_COLOR: '1',
            ...preload('excluded.mjs', `import fs from 'node:fs';
import cp from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
const record = value => fs.appendFileSync(${JSON.stringify(marker)}, value + '\\n');
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stderr, 'isTTY', { value: true });
process.stdin.setRawMode = () => { record('raw'); return process.stdin; };
const on = process.stdin.on;
process.stdin.on = function(name, ...args) { if (name === 'data' || name === 'readable') record('input'); return on.call(this, name, ...args); };
cp.fork = () => { record('spawn'); throw new Error('test renderer forbidden'); };
syncBuiltinESMExports();
registerHooks({ resolve(specifier, context, next) { if (specifier === 'ink' || specifier === 'react' || /cli-(?:tui|view)\\.js$/.test(specifier)) { record('ui'); throw new Error('test UI forbidden'); } return next(specifier, context); } });`),
        };
        const file = write('excluded.spl', "success(await human('question'));");
        for (const args of [['--help'], ['--version'], ['logout'], ['check', file], ['compile', file], ['doc', file], ['doc', file, '--format=html']]) {
            expect(run(args, env)).toMatchObject({ code: 0, err: '' });
        }
        write('excluded.spl', 'const n = 1;\nsuccess(n);');
        expect(run(['run', file, '--silent'], env)).toEqual({ code: 0, out: '1\n', err: '' });
        const library = spawnSync(process.execPath, ['--input-type=module', '-e',
            `import { Logger } from ${JSON.stringify(dist('index.js'))}; new Logger('info', () => {}).info('embedded');`],
        { encoding: 'utf8', env: { ...process.env, ...env } });
        expect(library.status).toBe(0);
        expect(fs.existsSync(marker)).toBe(false);
    });

    it('matches the six-event offline alias smoke workflow byte for byte', () => {
        const source = `let count = 1;
count = count;
count += 1;
const items = [1];
const alias = items;
alias.push(2);
success(count);`;
        const state = (name: string, before: string, after: string): string => `~ state ${name} @ global (scope-1): ${before} -> ${after}\n`;
        expect(spl(source, '--log-level', 'debug')).toEqual({
            code: 0, out: '2\n',
            err: state('count', '<unbound>', '1') + state('count', '1', '2')
                + state('items', '<unbound>', '[\n  1\n]') + state('alias', '<unbound>', '[\n  1\n]')
                + state('items', '[\n  1\n]', '[\n  1,\n  2\n]') + state('alias', '[\n  1\n]', '[\n  1,\n  2\n]'),
        });
        expect(spl(source, '--silent')).toEqual({ code: 0, out: '2\n', err: '' });
    });

    it('reports state changes of top-level variables only, and of the functions that are declared', () => {
        const result = spl('let count = 1;\nfunction bump(n: number) {\n    let inner = n;\n    inner++;\n    return inner;\n}\nfor (let i = 0; i < 2; i++) count = bump(count);\nsuccess(count);', '--log-level=debug');
        expect(result).toEqual({
            code: 0, out: '3\n',
            err: '~ state bump @ global (scope-1): <unbound> -> "<function bump(n) ref-1>"\n~ state count @ global (scope-1): <unbound> -> 1\n~ state count @ global (scope-1): 1 -> 3\n',
        });
    });

    it.each([undefined, 'error', 'info'] as const)('hides state changes at %s verbosity without changing results', level => {
        const result = spl('const items = [];\nitems.push(1);\nsuccess(items);', ...(level ? ['--log-level', level] : []));
        expect(result).toEqual({ code: 0, out: '[\n  1\n]\n', err: '' });
    });

    it('--silent suppresses logs', () => {
        const r = spl("log('hi');\nlog.error('bad');\nsuccess(1);", '--silent');
        expect(r.err).toBe('');
        expect(r.out).toBe('1\n');
    });

    it('--log-level error hides info logs', () => {
        const r = spl("log('hi');\nsuccess(1);", '--log-level', 'error');
        expect(r.err).not.toContain('[info]');
        expect(r.err).toBe('');
        expect(spl("log.error('bad');\nsuccess(1);", '--log-level', 'error').err).toContain('bad');
    });

    it('logs tool calls with their content in plain logs', () => {
        const result = spl("await writeFile('note.txt', 'one\\ntwo');\nconst text = await readFile('note.txt');\nsuccess(text.length);");
        expect(result).toMatchObject({ code: 0, out: '7\n' });
        expect(result.err).toBe('* tool writeFile note.txt\none\ntwo\n* tool readFile note.txt\none\ntwo\n');
        expect(spl("await readFile('missing.txt');").err).toContain("* tool readFile failed missing.txt\nreadFile 'missing.txt'");
        expect(spl("await writeFile('quiet.txt', 'x');", '--log-level', 'error').err).not.toContain('* tool');
    });

    it('passes repeated --arg values in order before and after the command and the file', () => {
        const file = write('args.spl', 'success([args, args[0], args[3], args.length, Object.isFrozen(args)]);');
        const result = run(['--arg=first', 'run', file, '--arg', 'two words', '--silent', '--arg=--model=x']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out)).toEqual([['first', 'two words', '--model=x'], 'first', null, 3, true]);
        expect(result.err).toBe('');
    });

    it('supports empty arguments and defaults to an empty argument list', () => {
        expect(JSON.parse(spl('success([args, args[0] ?? null]);', '--silent').out)).toEqual([[], null]);
        expect(JSON.parse(spl('success([args[0], args[1] ?? null]);', '--arg=', '--silent').out)).toEqual(['', null]);
        expect(check('const first: string = args[0];\nsuccess(first);', '--arg=x')).toEqual({ code: 0, out: '', err: '' });
    });

    it('exposes the child process environment', () => {
        const result = spl("success([env.SPL_HOME, env['SPL_HOME'], env.SPL_TEST_MISSING ?? null, 'SPL_HOME' in env]);", '--silent');
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out)).toEqual([path.join(dir, 'spl-home'), path.join(dir, 'spl-home'), null, true]);
    });

    it('resolves tool paths and restrictions against --cwd', () => {
        const base = path.join(dir, 'base');
        fs.mkdirSync(base);
        fs.writeFileSync(path.join(base, 'input.txt'), 'from base');
        const copying = "const input = await readFile('./input.txt');\nawait restrict('./out', () => writeFile('./out/copy.txt', input));\nsuccess(input);";
        expect(spl(copying, '--cwd', base, '--silent')).toEqual({ code: 0, out: 'from base\n', err: '' });
        expect(fs.readFileSync(path.join(base, 'out', 'copy.txt'), 'utf8')).toBe('from base');
        fs.rmSync(path.join(base, 'out'), { recursive: true });
        expect(spl(copying, '--cwd=base', '--silent')).toEqual({ code: 0, out: 'from base\n', err: '' });
        expect(fs.existsSync(path.join(base, 'out', 'copy.txt'))).toBe(true);
        expect(exists('out')).toBe(false);
        const outside = spl(copying, '--silent');
        expect(outside.code).toBe(1);
        expect(JSON.parse(outside.out)).toMatchObject({ status_code: 'tool_error', line: 1 });
        const blocked = spl("await restrict('./out', async () => {\n    await writeFile('./elsewhere.txt', 'x');\n});", '--cwd', base, '--silent');
        expect(blocked.code).toBe(1);
        expect(JSON.parse(blocked.out)).toMatchObject({
            status_code: 'restriction_violation', line: 2, command: "await writeFile('./elsewhere.txt', 'x');",
            reason: expect.stringContaining(path.join(base, 'out')),
        });
        expect(fs.existsSync(path.join(base, 'elsewhere.txt'))).toBe(false);
    });
});

describe('failures', () => {
    const failure = (result: { out: string }): Record<string, unknown> => JSON.parse(result.out) as Record<string, unknown>;

    it('prints the failure payload to stdout and exits non-zero', () => {
        const r = spl("const a = 1;\nfail('nope');", '--silent');
        expect(r.code).toBe(1);
        expect(r.err).toBe('');
        expect(r.out).toBe(JSON.stringify({ status: 'failure', reason: 'nope', command: "fail('nope');", line: 2, status_code: 'explicit_failure' }, null, 4) + '\n');
        const logged = spl("const a = 1;\nfail('nope');");
        expect(logged.out).toBe(r.out);
        expect(logged.err).toBe('x error explicit_failure: nope (line 2)\n');
    });

    it.each([
        ['assert(1 + 1 === 3, `sum is ${1 + 1}`);', 'assertion_failed', 'sum is 2', 1],
        ['const data = null;\ndata.field;', 'runtime_error', "TypeError: Cannot read properties of null (reading 'field')", 2],
        ["function parse(text: string) {\n    return JSON.parse(text);\n}\nparse('{');", 'runtime_error', expect.stringMatching(/^SyntaxError: /), 2],
        ["await readFile('./missing.txt');", 'tool_error', expect.stringContaining('missing.txt'), 1],
        ["Int.parse('1');", 'validation_failed', '$: expected Int, got "1"', 1],
        ["throw new Failure('explicit_failure', 'thrown');", 'explicit_failure', 'thrown', 1],
        ["await think('x');", 'runtime_error', 'ReferenceError: think is not defined', 1],
        ['go(1);', 'runtime_error', 'ReferenceError: go is not defined', 1],
    ])('reports the uncaught failure of %j as %s with exit code 1', (code, status, reason, line) => {
        const r = spl(code, '--silent');
        expect(r).toMatchObject({ code: 1, err: '' });
        expect(failure(r)).toEqual({ status: 'failure', reason, command: code.split('\n')[line - 1].trim(), line, status_code: status });
    });

    it('lets workflows catch failures and finish successfully', () => {
        const r = spl("let caught;\ntry {\n    fail('first');\n} catch (error) {\n    caught = [error instanceof Failure, error.statusCode, error.reason];\n}\nsuccess(caught);", '--silent');
        expect(r).toEqual({ code: 0, out: json([true, 'explicit_failure', 'first']), err: '' });
    });

    it('validates call options at runtime without contacting the model', () => {
        const r = spl("success(await ask('x', { len: 'huge' }));", '--silent');
        expect(r.code).toBe(1);
        expect(failure(r)).toMatchObject({ status_code: 'runtime_error', reason: expect.stringContaining('len must be'), line: 1 });
        expect(failure(spl("await agent('x', { seed: 1 });", '--silent'))).toMatchObject({ status_code: 'runtime_error', reason: expect.stringContaining('exclusive to ask()') });
        expect(failure(spl("await ask('x', { reasoning: 'extreme' });", '--silent'))).toMatchObject({ status_code: 'runtime_error', reason: 'reasoning must be none, low, medium, high, or max' });
    });

    const descending = "import { assert } from 'spl-lang';\nexport function descend(depth) {\n    assert(depth > 0, 'reached the bottom');\n    return descend(depth - 1);\n}\n";

    it('reports the calling line for failures raised inside a helper module', () => {
        write('helper.js', descending);
        const r = spl("import { descend } from './helper.js';\nconst unused = 1;\ndescend(3);", '--silent');
        expect(r).toMatchObject({ code: 1, err: '' });
        expect(failure(r)).toEqual({ status: 'failure', reason: 'reached the bottom', command: 'descend(3);', line: 3, status_code: 'assertion_failed' });
    });

    it('reports the calling line for failures raised more than ten frames below the workflow', () => {
        write('helper.js', descending);
        const r = spl("import { descend } from './helper.js';\nconst unused = 1;\ndescend(12);", '--silent');
        expect(r).toMatchObject({ code: 1, err: '' });
        expect(failure(r)).toEqual({ status: 'failure', reason: 'reached the bottom', command: 'descend(12);', line: 3, status_code: 'assertion_failed' });
    });

    it('reports a backend that fails to close as an llm_error of the run', () => {
        const env = preload('close-failure.mjs', `import { AiBackend } from ${JSON.stringify(dist('ai.js'))};
import { LlmError } from ${JSON.stringify(dist('llm.js'))};
AiBackend.prototype.close = async function() { throw new LlmError('cleanup failed'); };`);
        const result = run(['run', write('flow.spl', 'success(42);'), '--silent'], env);
        expect(result.code).toBe(1);
        expect(failure(result)).toMatchObject({ status_code: 'llm_error', reason: 'cleanup failed' });
        expect(run(['run', path.join(dir, 'flow.spl')], env).err).toBe('x error cleanup failed\n');
    });
});

describe('imports', () => {
    it('runs and checks the bundled Markdown library outside the installation directory', () => {
        const source = "import { Document } from 'spl-lang/markdown';\nassert(Document === markdown.Document, 'one copy of the library');\nsuccess(new Document().heading('Report', 1).toString());";
        expect(spl(source, '--silent')).toEqual({ code: 0, out: '# Report\n\n', err: '' });
        expect(check(source)).toEqual({ code: 0, out: '', err: '' });
    });

    it('resolves helper modules, packages, JSON and Node.js built-ins against the workflow folder, not --cwd', () => {
        const base = path.join(dir, 'base');
        write('workflows/helpers.js', 'export const double = value => value * 2;\n');
        write('workflows/typed.ts', 'export const label = (value: number): string => `#${value}`;\n');
        write('workflows/legacy.cjs', "module.exports = { kind: 'commonjs' };\n");
        write('workflows/settings.json', '{"factor":21}');
        write('workflows/node_modules/tiny/package.json', '{"name":"tiny","type":"module","main":"index.js"}');
        write('workflows/node_modules/tiny/index.js', "export const tiny = 'package';\n");
        write('base/helpers.js', "throw new Error('imported the wrong module');\n");
        write('base/input.txt', 'from base');
        const file = write('workflows/main.spl', `import path from 'node:path';
import { double } from './helpers.js';
import { label } from './typed.ts';
import legacy from './legacy.cjs';
import settings from './settings.json' with { type: 'json' };
import { tiny } from 'tiny';
const { EOL } = await import('node:os');
success([label(double(settings.factor)), legacy.kind, tiny, path.basename(import.meta.dirname), typeof EOL, await readFile('input.txt')]);`);
        const expected = { code: 0, out: json(['#42', 'commonjs', 'package', 'workflows', 'string', 'from base']), err: '' };
        expect(run(['run', file, '--cwd', base, '--silent'])).toEqual(expected);
        expect(run(['run', path.join('workflows', 'main.spl'), '--cwd', 'base', '--silent'])).toEqual(expected);
        expect(run(['check', file])).toEqual({ code: 0, out: '', err: '' });
        const elsewhere = run(['run', file, '--silent']);
        expect(elsewhere.code).toBe(1);
        expect(JSON.parse(elsewhere.out)).toMatchObject({ status_code: 'tool_error', reason: expect.stringContaining(path.join(dir, 'input.txt')), line: 8 });
    });

    it('fails a run whose import cannot be found', () => {
        const result = spl("const unused = 1;\nimport { double } from './helpers.js';\nawait writeFile('ran.txt', 'x');", '--silent');
        expect(result).toMatchObject({ code: 1, err: '' });
        expect(JSON.parse(result.out)).toMatchObject({ status_code: 'runtime_error', reason: expect.stringContaining('Cannot find module') });
        expect(exists('ran.txt')).toBe(false);
    });

    it('locates an import that cannot be found at its line', () => {
        const result = spl("const unused = 1;\nimport { double } from './helpers.js';", '--silent');
        expect(JSON.parse(result.out)).toMatchObject({ status_code: 'runtime_error', line: 2, command: "import { double } from './helpers.js';" });
    });

    it('shares the running runtime with helper modules that import spl-lang', () => {
        write('helper.js', `import { args, ask, human, log, success } from 'spl-lang';
export const first = () => args[0];
export const question = () => ask('Hi');
export async function finish() {
    log('from helper');
    success({ args: [...args], answer: await human('Sure?') });
}
`);
        const source = "import { finish, first } from './helper.js';\nassert(first() === 'one', 'the helper sees --arg values');\nawait finish();";
        expect(spl(source, '--arg=one', '--arg=two', '--human=yes', '--silent'))
            .toEqual({ code: 0, out: json({ args: ['one', 'two'], answer: 'yes' }), err: '' });
        expect(spl(source, '--arg=one', '--human=yes').err).toBe('[info] log: from helper\n');
        const asked = spl("import { question } from './helper.js';\nsuccess(await question());", '--silent');
        expect(asked).toMatchObject({ code: 1, err: '' });
        expect(JSON.parse(asked.out)).toMatchObject({ status_code: 'llm_error', reason: expect.stringContaining('no provider configured'), line: 2 });
    });

    it('imports other .spl files: their exports, their workflow and the lines of their failures', () => {
        const helper = write('lib/helper.spl', [
            "import { offset } from './deep/more.spl';",
            'export function double(n: number): number {',
            "    if (n < 0) throw new RangeError('negative');",
            '    return n * 2 + offset;',
            '}',
            'success(args.map(Number).map(double));',
        ].join('\n'));
        write('lib/deep/more.spl', 'export const offset: number = 0;\n');
        const file = write('main.spl', [
            "import sub, { double } from './lib/helper.spl';",
            'const doubled: number = double(Number(args[0]));',
            "success({ doubled, sub: await sub(['1', '2']), own: [...args] });",
        ].join('\n'));
        expect(run(['run', file, '--arg', '21', '--silent'])).toEqual({ code: 0, out: json({ doubled: 42, sub: [2, 4], own: ['21'] }), err: '' });
        const failed = run(['run', file, '--arg=-1']);
        expect(failed.code).toBe(1);
        expect(JSON.parse(failed.out)).toEqual({
            status: 'failure', reason: 'RangeError: negative', command: "if (n < 0) throw new RangeError('negative');", line: 3, status_code: 'runtime_error', source: helper,
        });
        expect(failed.err).toBe('x error runtime_error: RangeError: negative (line 3)\n');
        expect(fs.readdirSync(dir).sort()).toEqual(['lib', 'main.spl']);
        expect(fs.readdirSync(path.join(dir, 'lib')).sort()).toEqual(['deep', 'helper.spl']);
    });

    it('reports syntax problems of an imported .spl file with its path, before running anything', () => {
        const broken = write('lib/broken.spl', 'export const a = 1;\nenum Color { Red }');
        const result = spl("await writeFile('ran.txt', 'x');\nimport { a } from './lib/broken.spl';\nsuccess(a);");
        expect(result).toEqual({
            code: 2, out: '',
            err: `x error ${broken}:2:1: syntax error: Unsupported TypeScript syntax: \`enum\` cannot be erased; use a union of string literals instead of enum\n`,
        });
        expect(exists('ran.txt')).toBe(false);
    });
});

describe('syntax errors', () => {
    it('reports syntax errors on stderr with exit code 2 before running anything', () => {
        const file = path.join(dir, 's.spl');
        const r = spl("await writeFile('ran.txt', 'x');\nconst = 1;");
        expect(r).toMatchObject({ code: 2, out: '' });
        expect(r.err).toMatch(/^x error .*s\.spl:2:7: syntax error: invalid TypeScript: /);
        expect(r.err.startsWith(`x error ${file}:2:7: `)).toBe(true);
        expect(spl("await writeFile('ran.txt', 'x');\nlet a = 1;\nlet a = 2;", '--silent'))
            .toEqual({ code: 2, out: '', err: `x error ${file}:3:5: syntax error: Identifier 'a' has already been declared\n` });
        expect(spl(`await writeFile('ran.txt', 'x');\n${block('Hi')}\nsuccess(1;`, '--silent')).toMatchObject({ code: 2, out: '', err: expect.stringMatching(/s\.spl:2:1: syntax error: ask block needs outputVar/) });
        expect(spl("await writeFile('ran.txt', 'x');\n---\noutputVar: a\n\nHi")).toMatchObject({ code: 2, out: '', err: expect.stringContaining('s.spl:2:1: syntax error: Unmatched block opened at line 2') });
        expect(exists('ran.txt')).toBe(false);
    });

    // The table "Errors the scanner reports" of CHANGES.md, row by row.
    it.each([
        ['an odd number of fences', `${block('One', 'outputVar: a')}\nlet b = 1;\n---\noutputVar: c\n\nTwo`, '7:1', 'Unmatched block opened at line 7: every `---` needs a closing `---`'],
        ['a block in expression position', `const x =\n${block('One', 'outputVar: a')}`, '2:1', 'Blocks are statements: a `---` block cannot be used as an expression'],
        ['a Markdown comment below the top level', 'function f() {\n    //*\n    text\n    *//\n}', '2:5', 'Markdown comments (`//*`) are only allowed at the top level'],
        ['a Markdown comment inside a block', block('Text\n//*\nmore', 'outputVar: a'), '5:1', 'Markdown comments (`//*`) are only allowed at the top level'],
        ['an unclosed Markdown comment', 'let a = 1;\n//*\ntext', '2:1', 'Unclosed Markdown comment: `//*` needs a closing `*//` at the start of a line'],
        ['a misspelled header key', '---\nmodle: x\noutputVar: a\n\nText\n---', '2:1', 'unknown header key `modle`; did you mean `model`?'],
        ['a header key not valid for the mode', '---\nmode: agent\noutputVar: a\n\nText\n---', '3:1', '`outputVar` applies only to ask blocks'],
        ['an agent key in an ask block', '---\nrestrict: ./src\noutputVar: a\n\nText\n---', '2:1', '`restrict` applies only to agent blocks'],
        ['an ask block without outputVar', block('Tell a joke'), '1:1', 'ask block needs outputVar: name the variable that receives the answer, such as `outputVar: summary`'],
        ['an ask block with ->', block('Tell a joke -> @joke', 'outputVar: a'), '4:13', 'ask block needs outputVar: `->` declares outputs only in agent and codegen blocks'],
        ['a header-only block that is not first', 'let a = 1;\n---\nmodel: x\n---', '2:1', 'File defaults must come first: a block without an instruction sets defaults for the whole file'],
        ['2.x syntax', '{comment}\nNotes\n{/comment}', '1:1', 'SPL 2.x syntax; see the migration guide'],
        ['an enum', 'enum Color { Red }', '1:1', 'Unsupported TypeScript syntax: `enum` cannot be erased; use a union of string literals instead of enum'],
        ['a namespace', 'namespace Shapes { export const a = 1; }', '1:1', 'Unsupported TypeScript syntax: `namespace` cannot be erased; use an ES module or a plain object instead of namespace'],
        ['a parameter property', 'class A {\n    constructor(private readonly x: number) {}\n}', '2:17', 'Unsupported TypeScript syntax: parameter properties cannot be erased; declare the field and assign it in the constructor'],
        ['a decorator', '@sealed\nclass A {}', '1:1', 'Unsupported TypeScript syntax: decorators cannot be erased; call the decorator as a function instead'],
    ])('spl run reports %s with exit code 2', (_, source, position, message) => {
        const file = write('s.spl', source);
        const result = run(['run', file]);
        expect(result).toMatchObject({ code: 2, out: '' });
        expect(result.err.split('\n')[0]).toBe(`x error ${file}:${position}: syntax error: ${message}`);
    });

    it.each([
        ['{js} tags', "{js}\nawait writeFile('ran.txt', 'x');\n{/js}", [1, 3]],
        ['{agent} tags', "{agent model='x'}\nDo it\n{/agent}", [1, 3]],
        ['Markdown fences', "# Title\n\n```js\nawait writeFile('ran.txt', 'x');\n```\n\n> Do it\n", [3, 5]],
        ['Markdown frontmatter', "---\nextension: 'semantic-prompt-language'\nversion: 1\n---\n", [2, 3]],
    ])('fails a file with %s in every command, with the migration message', (_, source, lines) => {
        const file = write('old.spl', source);
        for (const command of ['run', 'compile', 'doc']) {
            const result = run([command, file]);
            expect(result).toMatchObject({ code: 2, out: '' });
            for (const line of lines) expect(result.err).toContain(`${file}:${line}:1: syntax error: SPL 2.x syntax; see the migration guide\n`);
        }
        const checked = run(['check', file]);
        expect(checked).toMatchObject({ code: 2, out: '' });
        for (const line of lines) expect(checked.err).toContain(`x error old.spl:${line}:1: SPL 2.x syntax; see the migration guide\n`);
        expect(fs.readdirSync(dir)).toEqual(['old.spl']);
    });

    it('checks blocks and their header keys offline, and runs statements and functions in order', () => {
        const body = (...header: string[]): string => [
            "await writeFile('ran.txt', 'x');", "const value = await ask('Not asked');",
            agentBlock('Double @value.', ...header), block('Define -> @double(value: number): number', 'mode: codegen'),
        ].join('\n');
        const file = write('mixed.spl', body('restrict: { fs: [./src], exec: git }', 'enforce: Be concise', 'model: m', 'reasoning: high'));
        expect(run(['check', file])).toEqual({ code: 0, out: '', err: '' });
        for (const [header, command, message] of [
            ['model: 42', 'check', '`model` must be a model id'],
            ['model: 42', 'run', '`model` must be a model id'],
            ['reasoning: extreme', 'check', '`reasoning` must be none, low, medium, high or max'],
            ['restrict: { disk: ./src }', 'check', '`restrict` must be a folder or { fs, exec, net, mcp } with strings or lists of strings'],
        ]) {
            write('mixed.spl', body(header));
            expect(run([command, file])).toMatchObject({ code: 2, out: '', err: expect.stringContaining(`mixed.spl:5:1: ${command === 'run' ? 'syntax error: ' : ''}${message}\n`) });
        }
        expect(exists('ran.txt')).toBe(false);
        write('mixed.spl', 'let value = 20;\nfunction double(n: number) {\n    return n * 2;\n}\n//*\nIgnored prose\n*//\nvalue = double(value);\nsuccess(value + 2);');
        expect(run(['run', file, '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
    });
});

describe('spl check', () => {
    const clean = [
        '//*', '# Title', '*//',
        '---', 'model: gpt-6-luna', '---',
        "import * as path from 'node:path';",
        "import sub, { double } from './lib/helper.spl';",
        "await writeFile('ran.txt', 'x');",
        'const Joke = Struct("Joke", { setup: Str, stars: Int });',
        'function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }',
        'let topic: string = path.basename(args[0] ?? "x");',
        block('A joke about @topic for @args in @env.HOME', 'outputVar: joke', 'outputType: Joke'),
        agentBlock('Call @fib with 10 ->[Int] @fib10, describe it -> @text and rename ->[Str] @=topic'),
        block('Slug of a title -> @slugify(text: string): string', 'mode: codegen'),
        'async function describe(item: string): Promise<string> {',
        '    ---', '    outputVar: summary', '', '    Describe @item', '    ---',
        '    return summary;',
        '}',
        'const stars: number = joke.stars + fib10 + double(1);',
        'const slug: string = slugify(await describe(joke.setup));',
        'const nested: unknown = await sub([topic]);',
        'success({ stars, slug, text, nested });',
    ].join('\n');

    it('accepts a clean file with every kind of block and an imported .spl file, without running or writing anything', () => {
        write('lib/helper.spl', 'export function double(n: number): number {\n    return n * 2;\n}\nsuccess(args.length);\n');
        const file = write('clean.spl', clean);
        expect(run(['check', file])).toEqual({ code: 0, out: '', err: '' });
        expect(run(['check', 'clean.spl', '--silent', '--log-level', 'debug'])).toEqual({ code: 0, out: '', err: '' });
        expect(fs.readdirSync(dir).sort()).toEqual(['clean.spl', 'lib']);
        expect(fs.readdirSync(path.join(dir, 'lib'))).toEqual(['helper.spl']);
    });

    it('does not run the workflow', () => {
        expect(check("fail('x');")).toEqual({ code: 0, out: '', err: '' });
        expect(check("success(await ask('Not asked'));\nawait human('Not asked either');")).toEqual({ code: 0, out: '', err: '' });
        expect(check('success(1;')).toMatchObject({ code: 2, out: '', err: expect.stringMatching(/^x error s\.spl:1:\d+: /) });
    });

    it('reports an unfinished last statement on a line of the file', () => {
        expect(check('fail(')).toMatchObject({ code: 2, out: '', err: expect.stringMatching(/^x error s\.spl:1:\d+: /) });
    });

    it('reports every scanner problem on its own line, before any type is checked', () => {
        const result = check(`let a: number = 'text';\n---\nmodel: x\n---\n${block('Tell a joke')}\nenum Color { Red }`);
        expect(result).toEqual({
            code: 2, out: '',
            err: 'x error s.spl:2:1: File defaults must come first: a block without an instruction sets defaults for the whole file\n'
                + 'x error s.spl:5:1: ask block needs outputVar: name the variable that receives the answer, such as `outputVar: summary`\n'
                + 'x error s.spl:8:1: Unsupported TypeScript syntax: `enum` cannot be erased; use a union of string literals instead of enum\n',
        });
    });

    it('maps TypeScript errors to .spl lines and columns, including inside blocks', () => {
        const source = [
            'const count: number = "three";',
            'function twice(n: number): number { return n * 2; }',
            '    twice("x");',
            block('Describe @missing and @count', 'outputVar: summary', 'outputType: Int'),
            'const upper: string = summary;',
            agentBlock('Sum @count ->[Int] @total and @nowhere -> @label'),
            'total.toUpperCase();',
            'label.trim();',
            block('A joke', 'outputVar: joke', 'outputType: Jok'),
            block('Again', 'outputVar: count'),
            'if (true) {',
            '    ---', '    outputVar: inner', '', '    Nested @absent', '    ---',
            '}',
            block('Slug -> @slugify(text: string): string', 'mode: codegen'),
            'slugify(42);',
        ].join('\n');
        const result = check(source);
        expect(result).toMatchObject({ code: 2, out: '' });
        expect(result.err.trimEnd().split('\n').map(line => line.replace(/^x error s\.spl:/, ''))).toEqual([
            "1:7: Type 'string' is not assignable to type 'number'.",
            "1:7: Cannot redeclare block-scoped variable 'count'.",
            "3:11: Argument of type 'string' is not assignable to parameter of type 'number'.",
            "8:11: Cannot find name 'missing'.",
            "10:7: Type 'number' is not assignable to type 'string'.",
            "14:32: Cannot find name 'nowhere'.",
            "16:7: Property 'toUpperCase' does not exist on type 'number'.",
            "17:1: 'label' is of type 'unknown'.",
            "20:13: Cannot find name 'Jok'. Did you mean 'joke'?",
            "24:1: Cannot redeclare block-scoped variable 'count'.",
            "33:13: Cannot find name 'absent'.",
            "41:9: Argument of type 'number' is not assignable to parameter of type 'string'.",
        ]);
    });

    it('reports a block in a function that is not async as TypeScript does', () => {
        const source = 'function f() {\n    ---\n    outputVar: a\n\n    Hi\n    ---\n}';
        expect(check(source)).toEqual({ code: 2, out: '', err: "x error s.spl:2:5: 'await' expressions are only allowed within async functions and at the top levels of modules.\n" });
        expect(spl(source)).toMatchObject({ code: 2, out: '', err: expect.stringMatching(/s\.spl:2:\d+: syntax error: invalid TypeScript: await/) });
    });

    it('reports a type error in an imported .spl file with the path of that file', () => {
        write('lib/helper.spl', 'export function double(n: number): number {\n    const text: string = n;\n    return n * 2;\n}\n');
        const helper = path.join('lib', 'helper.spl');
        expect(run(['check', write('main.spl', "import { double } from './lib/helper.spl';\nconst a: number = double(2);\nsuccess(a);")]))
            .toEqual({ code: 2, out: '', err: `x error ${helper}:2:11: Type 'number' is not assignable to type 'string'.\n` });
        expect(run(['check', write('main.spl', "import { double } from './lib/helper.spl';\nconst a: string = double('2');")])).toEqual({
            code: 2, out: '',
            err: `x error ${helper}:2:11: Type 'number' is not assignable to type 'string'.\n`
                + "x error main.spl:2:7: Type 'number' is not assignable to type 'string'.\n"
                + "x error main.spl:2:26: Argument of type 'string' is not assignable to parameter of type 'number'.\n",
        });
        write('lib/helper.spl', 'export const a = 1;\nenum Color { Red }');
        expect(run(['check', 'main.spl'])).toEqual({
            code: 2, out: '', err: `x error ${helper}:2:1: Unsupported TypeScript syntax: \`enum\` cannot be erased; use a union of string literals instead of enum\n`,
        });
        expect(fs.readdirSync(dir).sort()).toEqual(['lib', 'main.spl']);
    });

    it('names files outside the current folder by their full path', () => {
        const elsewhere = tempDir('spl-cli-other-');
        const file = path.join(elsewhere, 'far.spl');
        fs.writeFileSync(file, 'const count: number = "three";');
        expect(run(['check', file])).toEqual({ code: 2, out: '', err: `x error ${file}:1:7: Type 'string' is not assignable to type 'number'.\n` });
        expect(fs.readdirSync(elsewhere)).toEqual(['far.spl']);
    });

    it('reports imports that cannot be found without executing the modules that can', () => {
        write('helper.js', "import fs from 'node:fs';\nfs.writeFileSync('executed.txt', 'x');\nexport const value = 42;\n");
        expect(check("import os from 'node:os';\nimport { value } from './helper.js';\nsuccess([value, os.EOL]);")).toEqual({ code: 0, out: '', err: '' });
        expect(exists('executed.txt')).toBe(false);
        expect(check("import { a } from './missing-a.js';\nconst b = await import('./dynamic.js');\nimport unchecked from 'not-installed';")).toEqual({
            code: 2, out: '',
            err: "x error s.spl:1:19: Cannot find module './missing-a.js' or its corresponding type declarations.\n"
                + "x error s.spl:2:24: Cannot find module './dynamic.js' or its corresponding type declarations.\n"
                + "x error s.spl:3:23: Cannot find module 'not-installed' or its corresponding type declarations.\n",
        });
        const missing = check("const a = 1;\nimport { d } from './missing.spl';");
        expect(missing).toMatchObject({ code: 2, out: '' });
        expect(missing.err).toMatch(/^x error s\.spl:2:19: cannot read '.*missing\.spl': ENOENT/);
    });

    it('accepts a .spl file that is imported dynamically', () => {
        write('lib/more.spl', 'export const more: number = 1;\n');
        const source = "const lazy = await import('./lib/more.spl');\nsuccess(lazy.more);";
        expect(spl(source, '--silent')).toEqual({ code: 0, out: '1\n', err: '' });
        expect(check(source)).toEqual({ code: 0, out: '', err: '' });
    });
});

describe('spl compile', () => {
    const helper = [
        "import { offset } from './deep/more.spl';",
        'export function double(n: number): number {',
        '    return n * 2 + offset;',
        '}',
        'success(args.map(Number).map(double));',
    ].join('\n');
    const main = [
        '---', 'model: file-model', '---',
        "import sub, { double } from './lib/helper.spl';",
        "import { offset } from './lib/deep/more.spl';",
        "import { label } from './plain.ts';",
        'const doubled: number = double(Number(args[0])) + offset;',
        block('Describe @doubled', 'outputVar: note'),
        "if (note === 'fail') fail('asked to');",
        'success({ doubled, label: label(doubled), note, sub: await sub(["2"]) });',
    ].join('\n');
    const sources = (): void => {
        write('main.spl', main);
        write('lib/helper.spl', helper);
        write('lib/deep/more.spl', 'export const offset: number = 0;\n');
        write('plain.ts', 'export const label = (n: number): string => `#${n}`;\n');
    };

    it('writes <name>.ts beside the file and beside every .spl file it imports, and prints the paths', () => {
        sources();
        const result = run(['compile', 'main.spl']);
        expect(result).toMatchObject({ code: 0, err: '' });
        expect(result.out.trimEnd().split('\n').sort()).toEqual(['main.ts', path.join('lib', 'helper.ts'), path.join('lib', 'deep', 'more.ts')].sort());
        expect(fs.readdirSync(dir).sort()).toEqual(['lib', 'main.spl', 'main.ts', 'plain.ts']);
        expect(fs.readdirSync(path.join(dir, 'lib')).sort()).toEqual(['deep', 'helper.spl', 'helper.ts']);
        expect(fs.readdirSync(path.join(dir, 'lib', 'deep')).sort()).toEqual(['more.spl', 'more.ts']);
        expect(read('main.spl')).toBe(main);
        const output = read('main.ts');
        expect(output.split('\n')[0]).toBe('// Generated by `spl compile` from main.spl. Edit the .spl file, not this module.');
        expect(output).toMatch(/^import \{ __spl, [\w, ]+ \} from 'spl-lang';$/m);
        expect(output).toMatch(/^import sub, \{ double \} from '\.\/lib\/helper\.ts' ?;$/m);
        expect(output).toMatch(/^import \{ offset \} from '\.\/lib\/deep\/more\.ts' ?;$/m);
        expect(output).toContain("import { label } from './plain.ts';");
        expect(output).toContain('export default async function workflow(args: string[] = [], options?: __spl.WorkflowOptions): Promise<unknown> {');
        expect(output).toContain('defaults: {"model":"file-model"}');
        expect(output).toContain('const doubled: number = double(Number(args[0])) + offset;');
        expect(output).toContain('const note = await __spl.ask(');
        expect(output).not.toMatch(/\.spl['"]/);
        expect(read(path.join('lib', 'helper.ts'))).toMatch(/^import \{ offset \} from '\.\/deep\/more\.ts' ?;$/m);
        expect(read(path.join('lib', 'helper.ts'))).toContain('export function double(n: number): number {');
        expect(read(path.join('lib', 'deep', 'more.ts'))).toContain('export const offset: number = 0;');
    });

    it('accepts a full path and replaces the output of an earlier compilation', () => {
        sources();
        const file = path.join(dir, 'lib', 'helper.spl');
        const result = run(['compile', file]);
        expect(result).toMatchObject({ code: 0, err: '' });
        expect(result.out.trimEnd().split('\n').sort()).toEqual([path.join('lib', 'helper.ts'), path.join('lib', 'deep', 'more.ts')].sort());
        expect(exists('main.ts')).toBe(false);
        fs.writeFileSync(file, 'export const renamed = 1;\n');
        expect(run(['compile', file])).toEqual({ code: 0, out: `${path.join('lib', 'helper.ts')}\n`, err: '' });
        expect(read(path.join('lib', 'helper.ts'))).toContain('export const renamed = 1;');
        expect(read(path.join('lib', 'helper.ts'))).not.toContain('double');
    });

    it('emits modules that run with node wherever spl-lang resolves', () => {
        sources();
        expect(run(['compile', 'main.spl']).code).toBe(0);
        // A stand-in for the installed package: the name `spl-lang` resolves to this build.
        write('node_modules/spl-lang/package.json', '{"name":"spl-lang","type":"module","main":"index.js"}');
        write('node_modules/spl-lang/index.js', `export * from ${JSON.stringify(dist('index.js'))};\n`);
        write('runner.mjs', `import { Logger } from 'spl-lang';
import workflow from './main.ts';
const calls = [];
const backend = { async call(request) { calls.push([request.model, request.prompt]); return { text: process.argv[2], effective: {} }; }, async close() {} };
try {
    console.log(JSON.stringify({ value: await workflow(['21'], { backend, logger: new Logger('silent') }), calls }));
} catch (error) {
    console.log(JSON.stringify({ failure: [error.statusCode, error.reason, error.command] }));
}
`);
        const node = (reply: string): unknown => {
            const result = spawnSync(process.execPath, ['runner.mjs', reply], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...OFFLINE } });
            expect(result.status).toBe(0);
            return JSON.parse(result.stdout);
        };
        expect(node('A note.')).toEqual({
            value: { doubled: 42, label: '#42', note: 'A note.', sub: [4] },
            calls: [['file-model', 'Describe @doubled\n\nValues referenced above, as JSON:\n@doubled = 42']],
        });
        expect(node('fail')).toEqual({ failure: ['explicit_failure', 'asked to', "if (note === 'fail') fail('asked to');"] });
    });

    it.each([
        ['invalid TypeScript', 'const x = ;', /^x error .*bad\.spl:1:11: syntax error: invalid TypeScript: /],
        ['a scanner problem', block('Tell a joke'), /^x error .*bad\.spl:1:1: syntax error: ask block needs outputVar/],
        ['an export that uses a workflow variable', 'const limit = 3;\nexport function capped(n: number) {\n    return Math.min(n, limit);\n}',
            /^x error .*bad\.spl:3:24: syntax error: exported `capped` uses the workflow variable `limit`/],
    ])('reports %s with exit code 2 and writes nothing', (_, source, message) => {
        const result = run(['compile', write('bad.spl', source)]);
        expect(result).toMatchObject({ code: 2, out: '' });
        expect(result.err).toMatch(message);
        expect(fs.readdirSync(dir)).toEqual(['bad.spl']);
    });

    it('reports a syntax problem of an imported .spl file with exit code 2', () => {
        const broken = write('broken.spl', 'enum Color { Red }');
        const result = run(['compile', write('main.spl', "import './broken.spl';\nsuccess(1);")]);
        expect(result.code).toBe(2);
        expect(result.err).toBe(`x error ${broken}:1:1: syntax error: Unsupported TypeScript syntax: \`enum\` cannot be erased; use a union of string literals instead of enum\n`);
        expect(exists('broken.ts')).toBe(false);
    });

    it('compiles a .spl file that is imported dynamically', () => {
        write('lib/more.spl', 'export const more: number = 1;\n');
        const result = run(['compile', write('main.spl', "const lazy = await import('./lib/more.spl');\nsuccess(lazy.more);")]);
        expect(result.out.trimEnd().split('\n').sort()).toEqual(['main.ts', path.join('lib', 'more.ts')].sort());
        expect(exists(path.join('lib', 'more.ts'))).toBe(true);
    });
});

describe('spl doc', () => {
    const source = [
        '//*', '# Fibonacci check', '', 'Prose with `code`.', '*//', '',
        '---', 'model: gpt-6-luna', '---', '',
        "import * as path from 'node:path';", '// An ordinary comment', 'const Joke = Struct("Joke", { setup: Str });',
        "await writeFile('ran.txt', 'x');", '',
        block('A joke about @topic.\nSecond line.', 'outputVar: joke', 'outputType: Joke', 'enforce: Answer in Chinese'),
        '', 'async function nested() {', '    ---', '    outputVar: inner', '', '    Nested', '    ---', '    return inner;', '}', '',
        agentBlock('Call @nested ->[Str] @text', 'reasoning: high'),
        '//*', 'Closing words.', '*//',
        'success(joke);',
    ].join('\n');
    const markdown = `# Fibonacci check

Prose with \`code\`.

> **file defaults**
>
> | Setting | Value |
> | --- | --- |
> | \`model\` | \`gpt-6-luna\` |

\`\`\`ts
import * as path from 'node:path';
// An ordinary comment
const Joke = Struct("Joke", { setup: Str });
await writeFile('ran.txt', 'x');
\`\`\`

> **ask block**
>
> | Setting | Value |
> | --- | --- |
> | \`outputVar\` | \`joke\` |
> | \`outputType\` | \`Joke\` |
> | \`enforce\` | \`Answer in Chinese\` |
>
> A joke about @topic.  
> Second line.

\`\`\`ts
async function nested() {
    ---
    outputVar: inner

    Nested
    ---
    return inner;
}
\`\`\`

> **agent block**
>
> | Setting | Value |
> | --- | --- |
> | \`reasoning\` | \`high\` |
>
> Call @nested ->[Str] @text

Closing words.

\`\`\`ts
success(joke);
\`\`\`
`;

    it('prints Markdown by default: prose, one ts fence per run of code and a callout per top-level block', () => {
        const file = write('doc.spl', source);
        expect(run(['doc', file])).toEqual({ code: 0, out: markdown, err: '' });
        expect(run(['doc', 'doc.spl', '--format', 'md'])).toEqual({ code: 0, out: markdown, err: '' });
        expect(run(['doc', '--format=md', 'doc.spl'])).toEqual({ code: 0, out: markdown, err: '' });
        expect(fs.readdirSync(dir)).toEqual(['doc.spl']);
    });

    it('prints a self-contained HTML page with the documentation styles and highlighted code for --format html', () => {
        const result = run(['doc', write('doc.spl', source), '--format', 'html']);
        expect(result).toMatchObject({ code: 0, err: '' });
        const html = result.out;
        expect(html.startsWith('<!DOCTYPE html>\n<html lang="en">')).toBe(true);
        expect(html.trimEnd().endsWith('</html>')).toBe(true);
        expect(html).toContain('<title>doc.spl</title>');
        expect(/<style>([\s\S]*?)<\/style>/.exec(html)![1].length).toBeGreaterThan(1000);
        expect(html).not.toMatch(/<link[^>]+stylesheet|<script/);
        expect(html).toContain('<h1>Fibonacci check</h1>');
        expect(html).toContain('<p>Prose with <code>code</code>.</p>');
        expect(html).toContain('<p><strong>ask block</strong></p>');
        expect(html).toContain('<td><code>outputType</code></td>\n<td><code>Joke</code></td>');
        expect(html).toContain('<p>A joke about @topic.<br>Second line.</p>');
        expect(html).toContain('<p>Call @nested -&gt;[Str] @text</p>');
        expect(html).toContain('<code class="language-ts"><span class="hljs-keyword">import</span>');
        expect(html).toContain('<span class="hljs-comment">// An ordinary comment</span>');
        expect(html.match(/<figure class="code-block">/g)).toHaveLength(3);
        expect(fs.readdirSync(dir)).toEqual(['doc.spl']);
    });

    it('reports scanner problems with exit code 2 and prints nothing', () => {
        const file = write('bad.spl', `${block('Tell a joke')}\n//*\nunclosed`);
        for (const format of ['md', 'html']) {
            expect(run(['doc', file, `--format=${format}`])).toEqual({
                code: 2, out: '',
                err: `x error ${file}:1:1: syntax error: ask block needs outputVar: name the variable that receives the answer, such as \`outputVar: summary\`\n`
                    + `${file}:4:1: syntax error: Unclosed Markdown comment: \`//*\` needs a closing \`*//\` at the start of a line\n`,
            });
        }
    });
});

describe('blocks and models', () => {
    const flow = [
        '---', 'model: file-model', '---',
        'function twice(n: number): number { return n * 2; }',
        agentBlock('Double 4 with @twice ->[Int] @doubled', 'model: block-model'),
        block('Describe @doubled', 'outputVar: note', 'reasoning: high'),
        block('Upper case -> @shout(text: string): string', 'mode: codegen'),
        "const extra = await ask('More', { model: 'call-model' });",
        'success({ doubled, note, loud: shout(note), extra, args: [...args] });',
    ].join('\n');
    /** Plays the agent of `flow`, writes its generated function and numbers every other answer. */
    const playing = `async (request, call) => {
    if (!request.runtimeTools) return request.prompt.includes('Function description:') ? 'function shout(text) {\\n    return text.toUpperCase();\\n}' : 'Reply ' + call;
    await act(request, 'saveVariable', { name: 'doubled', value: await act(request, 'callFunction', { name: 'twice', args: [4] }) });
    return 'Saved.';
}`;

    it('runs ask, agent and codegen blocks, with --model above the models of calls, blocks and the file', () => {
        const file = write('flow.spl', flow);
        expect(run(['run', file, '--silent', '--arg', 'one', '--arg=two'], model(playing))).toEqual({
            code: 0, out: json({ doubled: 8, note: 'Reply 2', loud: 'REPLY 2', extra: 'Reply 4', args: ['one', 'two'] }), err: '',
        });
        const requests = calls();
        expect(requests.map(call => [call.kind, call.model, call.reasoning, call.tools > 0])).toEqual([
            ['agent', 'block-model', null, true], ['ask', 'file-model', 'high', false], ['ask', 'file-model', null, false], ['ask', 'call-model', null, false],
        ]);
        expect(requests[0].prompt).toContain('Instruction:\nDouble 4 with @twice ->[Int] @doubled');
        expect(requests[1].prompt).toBe('Describe @doubled\n\nValues referenced above, as JSON:\n@doubled = 8');
        expect(requests[2].prompt).toContain('Function description:\nUpper case -> @shout(text: string): string');
        expect(read('flow.shout.js')).toContain('function shout(text) {\n    return text.toUpperCase();\n}');
        // The generated function is now cached beside the workflow: only three calls remain.
        expect(run(['run', file, '--silent', '--model', 'cli-model'], model(playing)).out)
            .toBe(json({ doubled: 8, note: 'Reply 2', loud: 'REPLY 2', extra: 'Reply 3', args: [] }));
        expect(calls().map(call => [call.kind, call.model])).toEqual([['agent', 'cli-model'], ['ask', 'cli-model'], ['ask', 'cli-model']]);
        expect(run(['run', file, '--silent', '--model=provider/custom'], model(playing)).code).toBe(0);
        expect(calls().map(call => call.model)).toEqual(['provider/custom', 'provider/custom', 'provider/custom']);
    });

    it('logs the transcript of every block on stderr, by log level', () => {
        const file = write('flow.spl', flow);
        const logged = run(['run', file], model(playing));
        expect(logged.code).toBe(0);
        const lines = logged.err.split('\n');
        expect(lines.filter(line => /^(?:->|<-|i info|\* tool|x error|~ state) /.test(line)).map(line => line.replace(/ You are running.*| Generate JavaScript.*/, ''))).toEqual([
            '-> input agent', '<- output agent action {', '* tool callFunction @twice(4)', '<- output agent action {', '* tool saveVariable @doubled', 'i info llm agent call:', '<- output agent Saved.',
            '-> input ask Describe @doubled', 'i info llm ask call:', '<- output ask Reply 2',
            '-> input codegen', 'i info llm ask call:', '<- output codegen function shout(text) {', `i info codegen saved ${path.join(dir, 'flow.shout.js')}`,
            '-> input ask More', 'i info llm ask call:', '<- output ask Reply 4',
        ]);
        expect(logged.err).toContain('Inputs:\n- @twice: function twice(n)\n\nOutputs to save:\n- @doubled: Int, JSON Schema {\n  "type": "integer"\n}\n\nInstruction:\nDouble 4 with @twice ->[Int] @doubled\n\nCompleted actions and their results:\n[]\n');
        expect(logged.err).toContain('<- output agent action {\n  "name": "saveVariable",\n  "arguments": {\n    "name": "doubled",\n    "value": 8\n  }\n}\n');
        expect(logged.err).toContain('-> input ask Describe @doubled\n\nValues referenced above, as JSON:\n@doubled = 8\n');
        fs.unlinkSync(path.join(dir, 'flow.shout.js'));
        const errors = run(['run', file, '--log-level', 'error'], model(playing));
        expect(errors.out).toBe(logged.out);
        expect(errors.err).toContain('<- output agent Saved.\n');
        expect(errors.err).not.toMatch(/^i info /m);
        fs.unlinkSync(path.join(dir, 'flow.shout.js'));
        expect(run(['run', file, '--silent'], model(playing))).toEqual({ code: 0, out: logged.out, err: '' });
    });

    it('--log-level debug reports top-level variables and the outputs of blocks nested in functions', () => {
        const file = write('nested.spl', [
            'let total = 0;',
            'async function describe(item: string) {',
            '    let local = item.length;',
            '    ---', '    outputVar: summary', '', '    Describe @item', '    ---',
            '    local++;',
            '    return `${summary} (${local})`;',
            '}',
            "const seen = await describe('pear');",
            agentBlock('Count @seen ->[Int] @count and name it -> @label'),
            'total = count;',
            'success([total, seen, label]);',
        ].join('\n'));
        const counting = `async request => {
    if (!request.runtimeTools) return 'A fruit.';
    await act(request, 'saveVariable', { name: 'count', value: '1' });
    await act(request, 'saveVariable', { name: 'label', value: 'one' });
    return 'Done.';
}`;
        const result = run(['run', file, '--log-level', 'debug'], model(counting));
        expect(result).toMatchObject({ code: 0, out: json([1, 'A fruit. (5)', 'one']) });
        expect(result.err.split('\n').filter(line => line.startsWith('~ state '))).toEqual([
            '~ state describe @ global (scope-1): <unbound> -> "<async function describe(item) ref-1>"',
            '~ state total @ global (scope-1): <unbound> -> 0',
            '~ state summary @ block at line 4 (block-4): <unbound> -> "A fruit."',
            '~ state seen @ global (scope-1): <unbound> -> "A fruit. (5)"',
            '~ state count @ global (scope-1): <unbound> -> 1',
            '~ state label @ global (scope-1): <unbound> -> "one"',
            '~ state total @ global (scope-1): 0 -> 1',
        ]);
        expect(result.err).not.toMatch(/~ state (?:local|item) /);
        const info = run(['run', file, '--log-level', 'info'], model(counting));
        expect(info.out).toBe(result.out);
        expect(info.err).not.toContain('~ state');
        expect(info.err).toContain('<- output ask A fruit.\n');
    });

    it('answers the askHuman of an agent block from --human, then from stdin', () => {
        const file = write('colour.spl', `${agentBlock('Ask the human for a colour -> @colour')}\nsuccess([colour, await human('Fruit?')]);`);
        const asking = "async request => { await act(request, 'saveVariable', { name: 'colour', value: await act(request, 'askHuman', { question: 'Colour?' }) }); return 'Done.'; }";
        expect(run(['run', file, '--human', 'blue', '--silent'], model(asking), 'apple\n')).toEqual({ code: 0, out: json(['blue', 'apple']), err: 'Fruit?\n> ' });
        expect(run(['run', file, '--human=blue', '--human=fig', '--silent'], model(asking))).toEqual({ code: 0, out: json(['blue', 'fig']), err: '' });
        expect(run(['run', file, '--silent'], model(asking), 'red\npear\n')).toEqual({ code: 0, out: json(['red', 'pear']), err: 'Colour?\n> Fruit?\n> ' });
    });

    it('reports the failure of a block at its opening line, with the first line of its instruction', () => {
        const file = write('failing.spl', [
            'const topic = "pets";',
            agentBlock('Find a name for @topic\nand save it -> @name'),
            block('How many letters has @name?', 'outputVar: letters', 'outputType: Int'),
            'success([name, letters]);',
        ].join('\n'));
        const idle = run(['run', file], model("() => 'Nothing saved.'"));
        expect(idle.code).toBe(1);
        expect(JSON.parse(idle.out)).toEqual({ status: 'failure', reason: 'agent did not produce @name', command: 'Find a name for @topic', line: 2, status_code: 'validation_failed' });
        expect(idle.err.trimEnd().split('\n').at(-1)).toBe('x error validation_failed: agent did not produce @name (line 2)');
        const wrong = run(['run', file, '--silent'], model(`async request => {
    if (!request.runtimeTools) return '"many"';
    await act(request, 'saveVariable', { name: 'name', value: 'Rex' });
    return 'Done.';
}`));
        expect(wrong).toMatchObject({ code: 1, err: '' });
        expect(JSON.parse(wrong.out)).toEqual({ status: 'failure', reason: '$: expected Int, got "many"', command: 'How many letters has @name?', line: 8, status_code: 'validation_failed' });
        const undeclared = run(['run', file, '--silent'], model("async request => { await act(request, 'saveVariable', { name: 'other', value: 1 }); return 'Done.'; }"));
        expect(JSON.parse(undeclared.out)).toMatchObject({ status_code: 'runtime_error', reason: expect.stringContaining('agent tried to save @other'), line: 2 });
    });
});

describe('direct human input', () => {
    function prompt(code: string, input: string, ...args: string[]) {
        return run(['run', write('s.spl', code), ...args], {}, input);
    }

    it('consumes repeatable answers in question order without prompting or a checkpoint', () => {
        const result = spl("const a = await human('Color?');\nconst b = await human('Fruit?');\nsuccess([a, b, args]);",
            '--human', '  blue\nsky  ', '--human=--apple', '--arg=script', '--silent');
        expect(result).toEqual({ code: 0, out: '[\n  "  blue\\nsky  ",\n  "--apple",\n  [\n    "script"\n  ]\n]\n', err: '' });
        expect(fs.readdirSync(dir)).toEqual(['s.spl']);
        expect(spl("success(await human('Empty?'));", '--human=', '--silent')).toEqual({ code: 0, out: '\n', err: '' });
    });

    it('prompts directly on stderr even when silent and retains buffered lines and whitespace', () => {
        const result = prompt("const a = await human('Color?');\nconst b = await human('Fruit?');\nsuccess([a, b]);", '  blue  \r\n\r\n', '--silent');
        expect(result).toEqual({ code: 0, out: '[\n  "  blue  ",\n  ""\n]\n', err: 'Color?\n> Fruit?\n> ' });
    });

    it('prompts only for remaining questions and does not consume answers in skipped expressions', () => {
        const result = prompt("const skipped = false && await human('Skipped?');\nconst a = await human('Color?');\nconst b = await human('Fruit?');\nsuccess([skipped, a, b]);",
            'apple\n', '--human=blue', '--silent');
        expect(result).toEqual({ code: 0, out: '[\n  false,\n  "blue",\n  "apple"\n]\n', err: 'Fruit?\n> ' });
    });

    it('reports EOF as a script failure instead of suspending or inventing an answer', () => {
        const result = prompt("success(await human('Color?'));", '', '--silent');
        expect(result.code).toBe(1);
        expect(JSON.parse(result.out)).toMatchObject({
            status_code: 'runtime_error', reason: expect.stringContaining('stdin ended'), line: 1, command: "success(await human('Color?'));",
        });
        expect(result.err).toBe('Color?\n> ');
    });

    it('lets the workflow catch a missing answer and continue', () => {
        const result = prompt("let answer;\ntry {\n    answer = await human('Color?');\n} catch (error) {\n    answer = error.statusCode;\n}\nsuccess(answer);", '', '--silent');
        expect(result).toEqual({ code: 0, out: 'runtime_error\n', err: 'Color?\n> ' });
    });

    it('sanitizes terminal controls in questions without modifying answers', () => {
        const result = prompt("success(await human('Color?\u001b[31m\u0007'));", 'blue\n', '--silent');
        expect(result).toEqual({ code: 0, out: 'blue\n', err: 'Color?\n> ' });
    });
});

describe('append-only trace', () => {
    /** The runtime identity the CLI stores in trace headers, so the library can write traces the CLI accepts. */
    function cliRuntime(): string {
        const directory = path.dirname(CLI);
        return fingerprint([VERSION, process.version, ...fs.readdirSync(directory).filter(name => name.endsWith('.js')).sort()
            .map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')])]);
    }
    /** Kinds of the effects a trace recorded, in order. */
    const recorded = (name: string): string[] => read(name).trim().split('\n').map(line => JSON.parse(line) as { type: string; request?: string })
        .filter(event => event.type === 'intent').map(event => (JSON.parse(event.request!) as { kind: string }).kind);

    it('replays a completed flow byte-for-byte without prompts or explicit side effects', () => {
        const source = write('flow.spl', `const input = await readFile('input.txt');
const approval = await human('Approve?');
await writeFile('output.txt', approval);
success([input, approval, args, env.SPL_TRACE_INPUT]);`);
        const trace = path.join(dir, 'trace.jsonl');
        write('input.txt', 'original');
        const first = run(['run', source, '--trace', trace, '--arg=initial', '--silent'], { SPL_TRACE_INPUT: 'original' }, '  approved  \n');
        expect(first.code).toBe(0);
        expect(first.err).toBe('Approve?\n> ');
        expect(JSON.parse(first.out)).toEqual(['original', '  approved  ', ['initial'], 'original']);
        const original = fs.readFileSync(trace, 'utf8');
        expect(JSON.parse(original.split('\n')[0])).toMatchObject({ format: 'spl-trace', version: 2, cwd: dir, args: ['initial'] });
        expect(recorded('trace.jsonl')).toEqual(['tool', 'human', 'tool']);
        fs.unlinkSync(path.join(dir, 'input.txt'));
        fs.unlinkSync(path.join(dir, 'output.txt'));
        const replay = run(['run', source, '--trace', trace, '--silent'], { SPL_TRACE_INPUT: 'changed' });
        expect(replay).toEqual({ code: 0, out: first.out, err: '' });
        expect(fs.readFileSync(trace, 'utf8')).toBe(original);
        expect(exists('output.txt')).toBe(false);
        expect(fs.existsSync(`${trace}.lock`)).toBe(false);
    });

    it('records ask, agent and codegen blocks in the journal and replays them without a model', () => {
        const file = write('flow.spl', [
            '---', 'model: file-model', '---',
            'function twice(n: number): number { return n * 2; }',
            agentBlock('Double 4 with @twice ->[Int] @doubled and ask the human -> @approval'),
            block('Describe @doubled', 'outputVar: note'),
            block('Upper case -> @shout(text: string): string', 'mode: codegen'),
            "log('finished', note);",
            'success({ doubled, approval, note, loud: shout(note), args: [...args] });',
        ].join('\n'));
        const playing = `async (request, call) => {
    if (!request.runtimeTools) return request.prompt.includes('Function description:') ? 'function shout(text) { return text.toUpperCase(); }' : 'Reply ' + call;
    await act(request, 'saveVariable', { name: 'doubled', value: await act(request, 'callFunction', { name: 'twice', args: [4] }) });
    await act(request, 'saveVariable', { name: 'approval', value: await act(request, 'askHuman', { question: 'Sure?' }) });
    return 'Saved.';
}`;
        const expected = json({ doubled: 8, approval: 'yes', note: 'Reply 2', loud: 'REPLY 2', args: ['one'] });
        const first = run(['run', file, '--trace', 'run.jsonl', '--arg=one', '--human=yes'], model(playing));
        expect(first).toMatchObject({ code: 0, out: expected });
        expect(first.err).toContain('<- output agent Saved.\n');
        expect(first.err).toContain('[info] log: finished Reply 2\n');
        expect(calls()).toHaveLength(3);
        expect(recorded('run.jsonl')).toEqual(['agent-block', 'agent-block', 'agent-block', 'human', 'agent-block', 'agent-block', 'llm', 'codegen']);
        const journal = read('run.jsonl');
        fs.unlinkSync(path.join(dir, 'flow.shout.js'));
        // Neither a model nor an answer is available now: everything comes from the journal.
        expect(run(['run', file, '--trace', 'run.jsonl', '--arg=one', '--silent'], {}, '')).toEqual({ code: 0, out: expected, err: '' });
        expect(run(['run', file, '--trace', 'run.jsonl'], {}, '')).toMatchObject({ code: 0, out: expected, err: expect.not.stringMatching(/input|output|Sure\?/) });
        expect(read('run.jsonl')).toBe(journal);
        expect(exists('flow.shout.js')).toBe(false);
        for (const [option, message] of [['--arg=two', 'trace script arguments mismatch'], ['--model=other', 'trace configuration mismatch']]) {
            expect(run(['run', file, '--trace', 'run.jsonl', option, '--silent'], model(playing)))
                .toMatchObject({ code: 2, out: '', err: expect.stringContaining(`spl: cannot open trace: ${message}`) });
        }
        expect(calls()).toEqual([]);
        expect(read('run.jsonl')).toBe(journal);
    });

    it('replays model answers and agent actions recorded by the library, without credentials or a model', async () => {
        vi.stubEnv('SPL_TRACE_INPUT', 'original');
        const source = [
            "const answer = await ask('Answer briefly');", "const approval = await human('Approve?');",
            agentBlock('Combine @answer and @approval and save the result to -> @summary'),
            'success([answer, approval, summary, env.SPL_TRACE_INPUT]);',
        ].join('\n');
        const file = write('flow.spl', source);
        const traceFile = path.join(dir, 'trace.jsonl');
        const fake = backend(async request => {
            if (request.runtimeTools) await request.invokeAction!(save('summary', 'saved by the agent'));
            return { text: 'saved answer', reasoning: 'saved reasoning', effective: { model: 'test' } };
        });
        const trace = Trace.open(traceFile, {
            source, cwd: dir, runtime: cliRuntime(),
            configuration: { model: null, provider: null, mcp: null },
        });
        try {
            const result = await execute(source, { backend: fake, logger: silent, cwd: dir, file, trace, human: () => 'approved' });
            expect(result).toMatchObject({ status: 'success', value: ['saved answer', 'approved', 'saved by the agent', 'original'] });
            trace.finish(result);
        } finally {
            trace.close();
        }
        const original = fs.readFileSync(traceFile, 'utf8');
        const replay = run(['run', file, '--trace', traceFile, '--silent'], { SPL_TRACE_INPUT: 'changed' }, '');
        expect(replay).toEqual({ code: 0, out: json(['saved answer', 'approved', 'saved by the agent', 'original']), err: '' });
        expect(fs.readFileSync(traceFile, 'utf8')).toBe(original);
        for (const option of ['--model=other', '--arg=extra']) {
            expect(run(['run', file, '--trace', traceFile, option, '--silent'])).toMatchObject({ code: 2, out: '', err: expect.stringContaining('mismatch') });
        }
        expect(fs.readFileSync(traceFile, 'utf8')).toBe(original);
    });

    it('reuses generated code saved beside the workflow instead of calling a model', () => {
        const description = 'Define a function returning value multiplied by two -> @double(value: number): number';
        const file = write('flow.spl', `${block(description, 'mode: codegen')}\nsuccess(double(21));`);
        expect(run(['run', file, '--silent'], model("() => 'function double(value) {\\n    return value * 2;\\n}'"))).toEqual({ code: 0, out: '42\n', err: '' });
        expect(calls()).toHaveLength(1);
        expect(read('flow.double.js')).toMatch(/^\/\/ @CODEGEN sha256:[0-9a-f]{64}\nfunction double\(value\) \{\n {4}return value \* 2;\n\}\n$/);
        expect(run(['run', file, '--trace', 'first.jsonl', '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
        fs.unlinkSync(path.join(dir, 'flow.double.js'));
        expect(run(['run', file, '--trace', 'first.jsonl', '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
        const untraced = run(['run', file, '--silent']);
        expect(untraced.code).toBe(1);
        expect(JSON.parse(untraced.out)).toMatchObject({ status_code: 'llm_error', line: 1, command: description });
    });

    it('resumes an interrupted question using --human only for unrecorded answers', () => {
        const env = preload('interrupt-input.mjs', `import { Trace } from ${JSON.stringify(dist('trace.js'))};
const effect = Trace.prototype.effect;
Trace.prototype.effect = async function(request, perform, valid) {
    if (request.kind === 'human' && request.question === 'Second?' && !this.replaying && !process.env.CONTINUE_TRACE) {
        perform = () => { throw new Error('simulated interruption'); };
    }
    return effect.call(this, request, perform, valid);
};`);
        const source = write('flow.spl', `await writeFile('output.txt', 'original');
const first = await human('First?');
const second = await human('Second?');
success([first, second]);`);
        const trace = path.join(dir, 'resume.jsonl');
        const stopped = run(['run', source, '--trace', trace, '--human=one', '--silent'], env);
        expect(stopped.code).toBe(70);
        const prefix = fs.readFileSync(trace, 'utf8');
        write('output.txt', 'edited');
        expect(run(['run', source, '--trace', trace, '--human=two', '--silent'], { ...env, CONTINUE_TRACE: '1' }))
            .toEqual({ code: 0, out: '[\n  "one",\n  "two"\n]\n', err: '' });
        expect(read('output.txt')).toBe('edited');
        expect(fs.readFileSync(trace, 'utf8').startsWith(prefix)).toBe(true);
    });

    it('creates a fresh flow only for a different trace path, preserves failures, and writes no trace for spl check', () => {
        const firstFile = path.join(dir, 'first.jsonl');
        expect(check('success(1);', '--trace', firstFile)).toEqual({ code: 0, out: '', err: '' });
        expect(fs.existsSync(firstFile)).toBe(false);
        const writing = "await writeFile('effect.txt', 'original');\nsuccess(1);";
        const first = spl(writing, '--trace', firstFile, '--silent');
        expect(first).toEqual({ code: 0, out: '1\n', err: '' });
        write('effect.txt', 'changed');
        expect(spl(writing, '--trace', firstFile, '--silent')).toEqual(first);
        expect(read('effect.txt')).toBe('changed');
        expect(spl(writing, '--trace', path.join(dir, 'second.jsonl'), '--silent')).toEqual(first);
        expect(read('effect.txt')).toBe('original');
        const failureFile = path.join(dir, 'failure.jsonl');
        const failure = spl("fail('rejected');", '--trace', failureFile, '--silent');
        expect(failure.code).toBe(1);
        expect(JSON.parse(failure.out)).toMatchObject({ status_code: 'explicit_failure', reason: 'rejected' });
        const bytes = fs.readFileSync(failureFile, 'utf8');
        expect(spl("fail('rejected');", '--trace', failureFile, '--silent')).toEqual(failure);
        expect(fs.readFileSync(failureFile, 'utf8')).toBe(bytes);
        expect(spl('const unused = 1;', '--trace', path.join(dir, 'empty.jsonl'), '--silent')).toEqual({ code: 0, out: '', err: '' });
    });

    it('rejects mismatched scripts and arguments without changing the trace', () => {
        const trace = path.join(dir, 'guarded.jsonl');
        expect(spl('success(args);', '--trace', trace, '--arg=one', '--silent').code).toBe(0);
        const original = fs.readFileSync(trace, 'utf8');
        for (const result of [
            spl('success(2);', '--trace', trace, '--silent'),
            spl('success(args);', '--trace', trace, '--arg=two', '--silent'),
        ]) {
            expect(result.code).toBe(2);
            expect(result.out).toBe('');
            expect(result.err).toContain('mismatch');
        }
        expect(fs.readFileSync(trace, 'utf8')).toBe(original);
        expect(spl('success(args);', '--trace', trace, '--silent')).toEqual({ code: 0, out: json(['one']), err: '' });
    });

    it('writes both <name>.jsonl and <name>.html for --trace <name> and --trace <name>.jsonl', () => {
        write('note.txt', 'hello trace');
        const file = write('traced.spl', [
            agentBlock('Read note.txt and save it ->[Str] @loaded'),
            block('Summarize @loaded', 'outputVar: summary'),
            'success({ loaded, summary });',
        ].join('\n'));
        const playing = `async request => {
    if (!request.runtimeTools) return 'Summary of hello trace.';
    const loaded = await act(request, 'readFile', { path: 'note.txt' });
    await act(request, 'saveVariable', { name: 'loaded', value: loaded });
    return 'Agent done.';
}`;
        const res = run(['run', file, '--trace', 'report', '--silent'], model(playing));
        expect(res).toEqual({ code: 0, out: json({ loaded: 'hello trace', summary: 'Summary of hello trace.' }), err: '' });
        expect(exists('report.jsonl')).toBe(true);
        expect(exists('report.html')).toBe(true);
        const html = read('report.html');
        expect(html).toContain('traced.spl — SPL Trace');
        expect(html).toContain('✓ Completed');
        expect(html).toContain('Read note.txt and save it -&gt;[Str] @loaded');
        expect(html).toContain('Summary of hello trace.');
        expect(html).toContain('hello trace');
        // Replaying with --trace report (without model) preserves report.jsonl and refreshes report.html.
        const before = read('report.jsonl');
        expect(run(['run', file, '--trace', 'report', '--silent'])).toEqual(res);
        expect(read('report.jsonl')).toBe(before);
        expect(exists('report.html')).toBe(true);
    });
});

describe('provider and credential errors', () => {
    const asking = "success(await ask('Hi'));";

    it.each([
        [[], {}, 'no provider configured; set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY, or run spl login <provider>'],
        [['--provider', 'openai'], {}, 'no API key for openai; set OPENAI_API_KEY or run spl login openai'],
        [['--model', 'claude-test'], {}, 'no API key for anthropic; set ANTHROPIC_API_KEY or run spl login anthropic'],
        [['--model=google/custom'], {}, 'no API key for google; set GOOGLE_GENERATIVE_AI_API_KEY or run spl login google'],
        [['--model', 'claude-test', '--provider', 'openai'], {}, 'model belongs to anthropic, not the selected provider openai'],
        [[], { SPL_PROVIDER: 'nope' }, "unknown provider 'nope'; expected openai, anthropic, google"],
    ] as [string[], NodeJS.ProcessEnv, string][])('fails a model call with %j and %j before any request', (args, env, reason) => {
        const result = run(['run', write('s.spl', asking), ...args, '--silent'], env);
        expect(result).toMatchObject({ code: 1, err: '' });
        expect(JSON.parse(result.out)).toEqual({ status: 'failure', reason, command: asking, line: 1, status_code: 'llm_error' });
    });

    it('applies the file default model, --model precedence and saved-credential checks to blocks', () => {
        const instruction = 'Double @value and save it to -> @doubled';
        const file = write('s.spl', `---\nmodel: gemini-test\n---\nconst value = 20;\n${agentBlock(instruction)}\n${block('Describe @doubled', 'outputVar: note', 'model: claude-test')}`);
        const blocked = run(['run', file, '--silent']);
        expect(blocked.code).toBe(1);
        expect(JSON.parse(blocked.out)).toEqual({
            status: 'failure', reason: 'no API key for google; set GOOGLE_GENERATIVE_AI_API_KEY or run spl login google',
            command: instruction, line: 5, status_code: 'llm_error',
        });
        expect(JSON.parse(run(['run', file, '--model', 'gpt-test', '--silent']).out)).toMatchObject({ reason: expect.stringContaining('no API key for openai') });
        write('s.spl', `---\nmodel: gemini-test\n---\n${block('Describe the weather', 'outputVar: note', 'model: claude-test')}`);
        expect(JSON.parse(run(['run', file, '--silent']).out)).toMatchObject({ reason: expect.stringContaining('no API key for anthropic'), line: 4, command: 'Describe the weather' });
        fs.mkdirSync(path.join(dir, 'spl-home'));
        fs.writeFileSync(path.join(dir, 'spl-home', 'credentials.json'), 'not json');
        expect(JSON.parse(run(['run', file, '--silent']).out)).toMatchObject({
            status_code: 'llm_error', reason: 'cannot read saved credentials: invalid JSON; run spl logout to remove them',
        });
    });

    it('logs the failed call and its reason on stderr unless silent', () => {
        const result = spl(asking);
        expect(result.code).toBe(1);
        expect(result.err).toBe('-> input ask Hi\nx error llm_error: no provider configured; set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY, or run spl login <provider> (line 1)\n');
        expect(spl(asking, '--silent').err).toBe('');
    });

    it('rejects an unknown --provider as a usage error before running', () => {
        const result = spl("await writeFile('ran.txt', 'x');", '--provider', 'nope');
        expect(result).toMatchObject({ code: 2, out: '', err: expect.stringContaining("spl: unknown provider 'nope'; expected openai, anthropic, google") });
        expect(exists('ran.txt')).toBe(false);
    });

    it('logout removes saved credentials and tolerates their absence', () => {
        expect(run(['logout']).out).toBe('No saved credentials.\n');
        const home = path.join(dir, 'spl-home');
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ token: 'x' }));
        expect(run(['logout']).out).toBe('Saved credentials removed.\n');
        expect(fs.existsSync(path.join(home, 'credentials.json'))).toBe(false);
        expect(run(['logout', 'extra']).code).toBe(2);
    });

    it('requires a valid login provider and stores keys without echoing them', () => {
        expect(run(['login']).code).toBe(2);
        expect(run(['login', 'unknown']).code).toBe(2);
        expect(run(['login', 'openai', '--provider', 'google']).code).toBe(2);
        const result = run(['login', 'openai'], {}, 'private-openai-test-key\n');
        expect(result.code).toBe(0);
        expect(result.out).toContain('Default provider: openai');
        expect(result.out + result.err).not.toContain('private-openai-test-key');
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'spl-home', 'credentials.json'), 'utf8'))).toEqual({
            provider: 'openai', keys: { openai: 'private-openai-test-key' },
        });
        expect(run(['login', 'google'], {}, 'private-google-test-key\n').code).toBe(0);
        expect(run(['logout', 'openai']).code).toBe(0);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'spl-home', 'credentials.json'), 'utf8'))).toEqual({
            provider: 'google', keys: { google: 'private-google-test-key' },
        });
    });

    it('selects environment credentials without prompting and fails login cleanly on EOF', () => {
        const env = { OPENAI_API_KEY: 'environment-test-key' };
        const result = run(['login', '--provider', 'openai'], env);
        expect(result).toEqual({ code: 0, out: 'Configured openai using OPENAI_API_KEY. Default provider: openai.\n', err: '' });
        expect(fs.readFileSync(path.join(dir, 'spl-home', 'credentials.json'), 'utf8')).not.toContain(env.OPENAI_API_KEY);
        const eof = run(['login', 'anthropic'], {}, '');
        expect(eof.code).toBe(1);
        expect(eof.err).toContain('stdin ended');
    });

    it('validates --mcp without starting servers', () => {
        const file = write('mcp.json', JSON.stringify({ servers: { docs: { type: 'stdio', command: 'nonexistent-test-server' } } }));
        expect(spl('success(42);', '--mcp', file, '--silent')).toEqual({ code: 0, out: '42\n', err: '' });
        fs.writeFileSync(file, '{"servers":{"docs":{"type":"http","url":42}}}');
        expect(spl("await writeFile('ran.txt', 'x');", '--mcp', file)).toMatchObject({ code: 2, out: '', err: expect.stringContaining("server 'docs': url must be a string") });
        expect(spl("await writeFile('ran.txt', 'x');", '--mcp', path.join(dir, 'missing.json'))).toMatchObject({ code: 2, out: '', err: expect.stringContaining('MCP config') });
        expect(exists('ran.txt')).toBe(false);
    });
});
