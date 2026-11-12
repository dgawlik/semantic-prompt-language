import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codegenHeader, codegenSignature } from '../src/codegen.js';
import { parseMarkdown } from '../src/markdown.js';
import { Pin } from '../src/pin.js';
import { Trace, fingerprint } from '../src/trace.js';
import { run as execute } from '../src/workflow.js';
import { action, backend, cleanTemp, document, fence, quote, silent, tempDir } from './helpers.js';

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

const workflow = (code: string, language = 'js'): string => `${document(fence(code, language))}\n`;
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';

function run(args: string[], env: NodeJS.ProcessEnv = {}, input?: string) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8', cwd: dir, input,
        env: { ...process.env, ...OFFLINE, ...env, SPL_HOME: path.join(dir, 'spl-home') },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

function spl(code: string, ...args: string[]) {
    const file = path.join(dir, 's.md');
    fs.writeFileSync(file, workflow(code));
    return run([file, ...args]);
}

/** Loads a module into the spawned CLI before it starts, to inject faults without touching the sources. */
function preload(name: string, code: string): { NODE_OPTIONS: string } {
    const file = path.join(dir, name);
    fs.writeFileSync(file, code);
    return { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(file).href}` };
}

describe('import CLI', () => {
    it('runs and checks the bundled Markdown library outside the installation directory', () => {
        const source = "import { Document } from 'spl-lang/markdown';\nassert(Document === markdown.Document, 'one copy of the library');\nsuccess(new Document().heading('Report', 1).toString());";
        expect(spl(source, '--silent')).toEqual({ code: 0, out: '# Report\n\n', err: '' });
        expect(spl(source, '--check')).toEqual({ code: 0, out: '', err: '' });
    });

    it('resolves helper modules, packages, JSON and Node.js built-ins against --cwd, not the workflow folder', () => {
        const base = path.join(dir, 'base');
        const workflows = path.join(dir, 'workflows');
        fs.mkdirSync(path.join(base, 'node_modules', 'tiny'), { recursive: true });
        fs.mkdirSync(workflows);
        fs.writeFileSync(path.join(base, 'helpers.js'), 'export const double = value => value * 2;\n');
        fs.writeFileSync(path.join(base, 'typed.ts'), 'export const label = (value: number): string => `#${value}`;\n');
        fs.writeFileSync(path.join(base, 'legacy.cjs'), "module.exports = { kind: 'commonjs' };\n");
        fs.writeFileSync(path.join(base, 'settings.json'), '{"factor":21}');
        fs.writeFileSync(path.join(base, 'node_modules', 'tiny', 'package.json'), '{"name":"tiny","type":"module","main":"index.js"}');
        fs.writeFileSync(path.join(base, 'node_modules', 'tiny', 'index.js'), "export const tiny = 'package';\n");
        fs.writeFileSync(path.join(workflows, 'helpers.js'), "throw new Error('imported the wrong module');\n");
        const file = path.join(workflows, 'main.md');
        fs.writeFileSync(file, workflow(`import path from 'node:path';
import { double } from './helpers.js';
import { label } from './typed.ts';
import legacy from './legacy.cjs';
import settings from './settings.json' with { type: 'json' };
import { tiny } from 'tiny';
const { EOL } = await import('node:os');
success([label(double(settings.factor)), legacy.kind, tiny, path.basename(import.meta.dirname), typeof EOL]);`));
        expect(run([file, '--cwd', base, '--silent'])).toEqual({ code: 0, out: json(['#42', 'commonjs', 'package', 'workflows', 'string']), err: '' });
        expect(run([file, '--cwd', 'base', '--check'])).toEqual({ code: 0, out: '', err: '' });
        const elsewhere = run([file, '--silent']);
        expect(elsewhere.code).toBe(1);
        expect(JSON.parse(elsewhere.out)).toMatchObject({
            status_code: 'runtime_error', reason: expect.stringContaining('Cannot find module'), line: 8, command: "import { double } from './helpers.js';",
        });
    });

    it('shares the running runtime with helper modules that import spl-lang', () => {
        fs.writeFileSync(path.join(dir, 'helper.js'), `import { args, ask, human, log, success } from 'spl-lang';
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
        expect(JSON.parse(asked.out)).toMatchObject({ status_code: 'llm_error', reason: expect.stringContaining('no provider configured'), line: 8 });
    });

    it('--check reports missing relative imports against --cwd without executing module effects', () => {
        fs.writeFileSync(path.join(dir, 'helper.js'), "import fs from 'node:fs';\nfs.writeFileSync('executed.txt', 'x');\nexport const value = 42;\n");
        const source = "import os from 'node:os';\nimport { value } from './helper.js';\nimport unchecked from 'not-installed';\nsuccess(value);";
        expect(spl(source, '--check')).toEqual({ code: 0, out: '', err: '' });
        expect(fs.existsSync(path.join(dir, 'executed.txt'))).toBe(false);
        fs.mkdirSync(path.join(dir, 'other'));
        const moved = spl(source, '--check', '--cwd', 'other');
        expect(moved).toMatchObject({ code: 2, out: '' });
        expect(moved.err).toBe(`x error ${path.join(dir, 's.md')}:8:1: cannot find module './helper.js' (resolved to ${path.join(dir, 'other', 'helper.js')})\n`);
        const missing = spl("import { a } from './missing-a.js';\nconst b = await import('./dynamic.js');\nimport { c } from '../missing-c.mjs';", '--check');
        expect(missing).toMatchObject({ code: 2, out: '' });
        expect(missing.err.match(/^x error .*$/gm)).toHaveLength(2);
        expect(missing.err).toContain("s.md:7:1: cannot find module './missing-a.js'");
        expect(missing.err).toContain("s.md:9:1: cannot find module '../missing-c.mjs'");
    });

    it('re-imports helper modules natively when a locked workflow replays', () => {
        const helper = path.join(dir, 'helper.js');
        fs.writeFileSync(helper, 'export const value = 42;\n');
        expect(spl("import { value } from './helper.js';\nsuccess(value);", '--pin', '--silent')).toEqual({ code: 0, out: '42\n', err: '' });
        const locked = path.join(dir, 's.locked.md');
        fs.writeFileSync(helper, 'export const value = 43;\n');
        expect(run([locked, '--silent'])).toEqual({ code: 0, out: '43\n', err: '' });
        fs.unlinkSync(helper);
        expect(run([locked, '--check'])).toMatchObject({ code: 2, out: '', err: expect.stringContaining("cannot find module './helper.js'") });
        const replay = run([locked, '--silent']);
        expect(replay.code).toBe(1);
        expect(JSON.parse(replay.out)).toMatchObject({ status_code: 'runtime_error', reason: expect.stringContaining('Cannot find module') });
    });
});

describe('fence languages', () => {
    it('rejects spl fences with the migration message and exit code 2', () => {
        const file = path.join(dir, 's.md');
        fs.writeFileSync(file, workflow("success 'old'", 'spl'));
        for (const args of [[file], [file, '--check']]) {
            expect(run(args)).toEqual({
                code: 2, out: '',
                err: `x error ${file}:6:1: syntax error: spl fences are no longer supported: write the step in a js fence, where ask, agent, restrict and the rest of the library are already imported\n`,
            });
        }
        fs.writeFileSync(file, `${document(`${fence("await writeFile('ran.txt', 'x');")}\n\n${fence('let a = 1', 'spl')}`)}\n`);
        expect(run([file, '--silent'])).toMatchObject({ code: 2, out: '', err: expect.stringContaining('s.md:10:1: syntax error: spl fences are no longer supported') });
        expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false);
    });

    it('runs ts fences with their types erased, sharing the scope with js fences', () => {
        const file = path.join(dir, 's.md');
        fs.writeFileSync(file, workflow('interface Point { x: number; y: number }\nconst point: Point = { x: 40, y: 2 };\nsuccess(point.x + (point.y as number));', 'ts'));
        expect(run([file, '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
        fs.writeFileSync(file, `${document(`${fence('const base = 40;')}\n\n${fence('const total: number = base + 2;', 'typescript')}\n\n${fence('success(total);', 'javascript')}`)}\n`);
        expect(run([file, '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
        fs.writeFileSync(file, workflow('enum Color { Red }\nsuccess(Color.Red);', 'ts'));
        expect(run([file, '--silent'])).toMatchObject({ code: 2, out: '', err: expect.stringMatching(/s\.md:7:\d+: syntax error: /) });
    });

    it('skips ignored fences and other languages', () => {
        const file = path.join(dir, 's.md');
        fs.writeFileSync(file, `${document(`${fence("fail('ignored');", 'js ignore')}\n\n${fence("fail('no-run');", 'ts no-run')}\n\n${fence("fail('python')", 'python')}\n\n${fence("success('ran');")}`)}\n`);
        expect(run([file, '--silent'])).toEqual({ code: 0, out: 'ran\n', err: '' });
    });
});

describe('pinned workflow CLI', () => {
    it('saves a successful run beside its source and replays all external inputs without effects or prompts', () => {
        const source = workflow(`const seed = ['initial'];
const input = await readFile('input.txt');
const approval = await human('Approve?');
await writeFile('effect.txt', approval);
seed.push('changed');
success([input, approval, env.SPL_PIN_CLI, args, seed]);`);
        const file = path.join(dir, 'flow.md');
        const locked = path.join(dir, 'flow.locked.md');
        fs.writeFileSync(file, source);
        fs.writeFileSync(path.join(dir, 'input.txt'), 'original input');
        const first = run([file, '--pin', '--silent', '--human=  approved  ', '--model=pinned-model', '--arg=original'],
            { SPL_PIN_CLI: 'original environment' });
        expect(first.code).toBe(0);
        expect(first.err).toBe('');
        expect(JSON.parse(first.out)).toEqual(['original input', '  approved  ', 'original environment', ['original'], ['initial', 'changed']]);
        expect(fs.readFileSync(file, 'utf8')).toBe(source);
        const lockedSource = fs.readFileSync(locked, 'utf8');
        expect(lockedSource.startsWith(source)).toBe(true);
        expect(lockedSource).toContain('>> ```spl-lock');
        fs.unlinkSync(path.join(dir, 'effect.txt'));
        fs.unlinkSync(path.join(dir, 'input.txt'));
        const replay = run([locked, '--silent'], { SPL_PIN_CLI: 'changed environment' }, '');
        expect(replay).toEqual(first);
        expect(fs.existsSync(path.join(dir, 'effect.txt'))).toBe(false);
        expect(fs.readFileSync(locked, 'utf8')).toBe(lockedSource);
    });

    it('replays model answers and agent actions pinned by the library, without credentials or a model', async () => {
        const source = `${document(`${fence('const answer = await ask(`Answer ${args[0]}`, { model: \'other\' });')}

> Summarize @answer and save it to @summary

${fence('success([answer, summary, args]);')}`)}\n`;
        const model = backend(async request => {
            if (request.naturalLanguage) await request.invokeAction!(action('save_variable', { name: 'summary', value: 'saved by the agent' }));
            return { text: 'captured answer', reasoning: 'captured reasoning', effective: { model: request.model } };
        });
        const pin = Pin.capture(source, { cwd: dir, args: ['original'], model: 'pinned-model' });
        const live = await execute(parseMarkdown(source), { backend: model, logger: silent, cwd: dir, args: ['original'], model: 'pinned-model', pin });
        expect(live).toMatchObject({ status: 'success', value: ['captured answer', 'saved by the agent', ['original']] });
        const locked = path.join(dir, 'flow.locked.md');
        fs.writeFileSync(locked, pin.toMarkdown(source));
        expect(fs.readFileSync(locked, 'utf8')).toContain('captured reasoning');
        expect(run([locked, '--silent'])).toEqual({ code: 0, out: json(['captured answer', 'saved by the agent', ['original']]), err: '' });
        expect(run([locked, '--check'])).toEqual({ code: 0, out: '', err: '' });
        const logged = run([locked]);
        expect(logged).toMatchObject({ code: 0, out: json(['captured answer', 'saved by the agent', ['original']]) });
        expect(logged.err).toContain('captured answer');
    });

    it('uses a sibling .locked.md path, independently of --cwd, including uppercase Markdown extensions', () => {
        const base = path.join(dir, 'base');
        fs.mkdirSync(base);
        const file = path.join(dir, 'FLOW.MD');
        fs.writeFileSync(file, workflow('success(42);'));
        expect(run([file, '--pin', '--cwd', base, '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
        expect(fs.existsSync(path.join(dir, 'FLOW.locked.md'))).toBe(true);
        expect(fs.existsSync(path.join(base, 'FLOW.locked.md'))).toBe(false);
        expect(run([path.join(dir, 'FLOW.locked.md'), '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
    });

    it('does not pin failures or syntax checks, and refuses to overwrite a lock before executing', () => {
        const locked = path.join(dir, 's.locked.md');
        expect(spl("fail('failed');", '--pin', '--silent').code).toBe(1);
        expect(fs.existsSync(locked)).toBe(false);
        expect(spl("success(await ask('No credentials'));", '--pin', '--silent').code).toBe(1);
        expect(fs.existsSync(locked)).toBe(false);
        expect(spl('const = 1;', '--pin', '--silent').code).toBe(2);
        expect(fs.existsSync(locked)).toBe(false);
        expect(spl("success(await ask('Not executed'));", '--pin', '--check', '--silent')).toEqual({ code: 0, out: '', err: '' });
        expect(fs.existsSync(locked)).toBe(false);
        fs.writeFileSync(locked, 'existing content');
        const result = spl("await writeFile('should-not-exist', 'content');", '--pin', '--silent');
        expect(result.code).toBe(2);
        expect(result.err).toContain('already exists');
        expect(fs.readFileSync(locked, 'utf8')).toBe('existing content');
        expect(fs.existsSync(path.join(dir, 'should-not-exist'))).toBe(false);
    });

    it('does not publish a lock when backend cleanup fails', () => {
        const env = preload('close-failure.mjs', `import { AiBackend } from ${JSON.stringify(dist('ai.js'))};
import { LlmError } from ${JSON.stringify(dist('llm.js'))};
AiBackend.prototype.close = async function() { throw new LlmError('cleanup failed'); };`);
        const file = path.join(dir, 'flow.md');
        fs.writeFileSync(file, workflow('success(42);'));
        const result = run([file, '--pin', '--silent'], env);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.out)).toMatchObject({ status_code: 'llm_error', reason: 'cleanup failed' });
        expect(fs.existsSync(path.join(dir, 'flow.locked.md'))).toBe(false);
    });

    it('rejects --pin with --trace before running', () => {
        const result = spl("await writeFile('should-not-exist', 'content');\nsuccess(42);", '--pin', '--trace=trace.jsonl', '--silent');
        expect(result.code).toBe(2);
        expect(result.err).toContain('--pin cannot be combined');
        expect(fs.readdirSync(dir)).toEqual(['s.md']);
    });

    it('rejects live overrides and missing journals without falling back to execution', () => {
        expect(spl('success(args);', '--pin', '--arg=original', '--silent').code).toBe(0);
        const locked = path.join(dir, 's.locked.md');
        for (const option of ['--pin', '--mcp=missing.json', '--human=answer', '--trace=trace.jsonl']) {
            const result = run([locked, option, '--silent']);
            expect(result.code).toBe(2);
            expect(result.err).toContain('locked workflows cannot');
        }
        for (const option of ['--arg=changed', '--model=changed', `--cwd=${path.join(dir, 'other')}`]) {
            const result = run([locked, option, '--silent']);
            expect(result.code).toBe(1);
            expect(JSON.parse(result.out)).toMatchObject({ reason: expect.stringContaining('options mismatch') });
        }
        expect(run([locked, '--arg=original', `--cwd=${dir}`, '--silent'])).toEqual({ code: 0, out: json(['original']), err: '' });
        const edited = fs.readFileSync(locked, 'utf8').replace('success(args);', 'success([...args, 1]);');
        fs.writeFileSync(locked, edited);
        expect(run([locked, '--silent'])).toMatchObject({ code: 2, out: '', err: expect.stringContaining('locked workflow source mismatch') });
        fs.writeFileSync(locked, workflow("success(await ask('Must not run live'));"));
        const missing = run([locked, '--silent']);
        expect(missing.code).toBe(2);
        expect(missing.err).toContain('missing its execution journal');
    });
});

describe('direct human input CLI', () => {
    function prompt(code: string, input: string, ...args: string[]) {
        const file = path.join(dir, 's.md');
        fs.writeFileSync(file, workflow(code));
        return run([file, ...args], {}, input);
    }

    it('consumes repeatable answers in question order without prompting or a checkpoint', () => {
        const result = spl("const a = await human('Color?');\nconst b = await human('Fruit?');\nsuccess([a, b, args]);",
            '--human', '  blue\nsky  ', '--human=--apple', '--arg=script', '--silent');
        expect(result).toEqual({ code: 0, out: '[\n  "  blue\\nsky  ",\n  "--apple",\n  [\n    "script"\n  ]\n]\n', err: '' });
        expect(fs.readdirSync(dir)).toEqual(['s.md']);
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
            status_code: 'runtime_error', reason: expect.stringContaining('stdin ended'), line: 7, command: "success(await human('Color?'));",
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

describe('append-only trace CLI', () => {
    /** The runtime identity the CLI stores in trace headers, so the library can write traces the CLI accepts. */
    function cliRuntime(): string {
        const directory = path.dirname(CLI);
        return fingerprint([VERSION, process.version, ...fs.readdirSync(directory).filter(name => name.endsWith('.js')).sort()
            .map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')])]);
    }

    it('replays a completed flow byte-for-byte without prompts or explicit side effects', () => {
        const source = path.join(dir, 'flow.md');
        const trace = path.join(dir, 'trace.jsonl');
        fs.writeFileSync(source, workflow(`const input = await readFile('input.txt');
const approval = await human('Approve?');
await writeFile('output.txt', approval);
success([input, approval, args, env.SPL_TRACE_INPUT]);`));
        fs.writeFileSync(path.join(dir, 'input.txt'), 'original');
        const first = run([source, '--trace', trace, '--arg=initial', '--silent'], { SPL_TRACE_INPUT: 'original' }, '  approved  \n');
        expect(first.code).toBe(0);
        expect(first.err).toBe('Approve?\n> ');
        expect(JSON.parse(first.out)).toEqual(['original', '  approved  ', ['initial'], 'original']);
        const original = fs.readFileSync(trace, 'utf8');
        expect(JSON.parse(original.split('\n')[0])).toMatchObject({ format: 'spl-trace', version: 2, cwd: dir, args: ['initial'] });
        fs.unlinkSync(path.join(dir, 'input.txt'));
        fs.unlinkSync(path.join(dir, 'output.txt'));
        const replay = run([source, '--trace', trace, '--silent'], { SPL_TRACE_INPUT: 'changed' });
        expect(replay).toEqual({ code: 0, out: first.out, err: '' });
        expect(fs.readFileSync(trace, 'utf8')).toBe(original);
        expect(fs.existsSync(path.join(dir, 'output.txt'))).toBe(false);
        expect(fs.existsSync(`${trace}.lock`)).toBe(false);
    });

    it('replays model answers and agent actions recorded by the library, without credentials or a model', async () => {
        vi.stubEnv('SPL_TRACE_INPUT', 'original');
        const source = `${document(`${fence("const answer = await ask('Answer briefly');\nconst approval = await human('Approve?');")}

> Combine @answer and @approval and save the result to @summary

${fence('success([answer, approval, summary, env.SPL_TRACE_INPUT]);')}`)}\n`;
        const file = path.join(dir, 'flow.md');
        const traceFile = path.join(dir, 'trace.jsonl');
        fs.writeFileSync(file, source);
        const model = backend(async request => {
            if (request.naturalLanguage) await request.invokeAction!(action('save_variable', { name: 'summary', value: 'saved by the agent' }));
            return { text: 'saved answer', reasoning: 'saved reasoning', effective: { model: 'test' } };
        });
        const trace = Trace.open(traceFile, {
            source: source.split(/\r?\n/).join('\n'), cwd: dir, runtime: cliRuntime(),
            configuration: { model: null, provider: null, mcp: null },
        });
        try {
            const recorded = await execute(parseMarkdown(source), { backend: model, logger: silent, cwd: dir, file, trace, human: () => 'approved' });
            expect(recorded).toMatchObject({ status: 'success', value: ['saved answer', 'approved', 'saved by the agent', 'original'] });
            trace.finish(recorded);
        } finally {
            trace.close();
        }
        const original = fs.readFileSync(traceFile, 'utf8');
        const replay = run([file, '--trace', traceFile, '--silent'], { SPL_TRACE_INPUT: 'changed' }, '');
        expect(replay).toEqual({ code: 0, out: json(['saved answer', 'approved', 'saved by the agent', 'original']), err: '' });
        expect(fs.readFileSync(traceFile, 'utf8')).toBe(original);
        for (const option of ['--model=other', '--arg=extra']) {
            expect(run([file, '--trace', traceFile, option, '--silent'])).toMatchObject({ code: 2, out: '', err: expect.stringContaining('mismatch') });
        }
        expect(fs.readFileSync(traceFile, 'utf8')).toBe(original);
    });

    it('reuses generated code saved beside the workflow instead of calling a model', () => {
        const description = 'Define double(value), returning value multiplied by two';
        const file = path.join(dir, 'flow.md');
        fs.writeFileSync(file, `${document(`> @CODEGEN '${description}'\n\n${fence('success(double(21));')}`)}\n`);
        fs.writeFileSync(path.join(dir, 'flow.double.js'), `${codegenHeader(codegenSignature(description))}\nfunction double(value) {\n    return value * 2;\n}\n`);
        expect(run([file, '--trace', 'first.jsonl', '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
        fs.unlinkSync(path.join(dir, 'flow.double.js'));
        expect(run([file, '--trace', 'first.jsonl', '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
        const untraced = run([file, '--silent']);
        expect(untraced.code).toBe(1);
        expect(JSON.parse(untraced.out)).toMatchObject({ status_code: 'llm_error', line: 6, command: `> @CODEGEN '${description}'` });
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
        const source = path.join(dir, 'flow.md');
        const trace = path.join(dir, 'resume.jsonl');
        fs.writeFileSync(source, workflow(`await writeFile('output.txt', 'original');
const first = await human('First?');
const second = await human('Second?');
success([first, second]);`));
        const stopped = run([source, '--trace', trace, '--human=one', '--silent'], env);
        expect(stopped.code).toBe(70);
        const prefix = fs.readFileSync(trace, 'utf8');
        fs.writeFileSync(path.join(dir, 'output.txt'), 'edited');
        expect(run([source, '--trace', trace, '--human=two', '--silent'], { ...env, CONTINUE_TRACE: '1' }))
            .toEqual({ code: 0, out: '[\n  "one",\n  "two"\n]\n', err: '' });
        expect(fs.readFileSync(path.join(dir, 'output.txt'), 'utf8')).toBe('edited');
        expect(fs.readFileSync(trace, 'utf8').startsWith(prefix)).toBe(true);
    });

    it('creates a fresh flow only for a different trace path, preserves failures, and skips --check output', () => {
        const firstFile = path.join(dir, 'first.jsonl');
        expect(spl('success(1);', '--trace', firstFile, '--check')).toEqual({ code: 0, out: '', err: '' });
        expect(fs.existsSync(firstFile)).toBe(false);
        const writing = "await writeFile('effect.txt', 'original');\nsuccess(1);";
        const first = spl(writing, '--trace', firstFile, '--silent');
        expect(first).toEqual({ code: 0, out: '1\n', err: '' });
        fs.writeFileSync(path.join(dir, 'effect.txt'), 'changed');
        expect(spl(writing, '--trace', firstFile, '--silent')).toEqual(first);
        expect(fs.readFileSync(path.join(dir, 'effect.txt'), 'utf8')).toBe('changed');
        expect(spl(writing, '--trace', path.join(dir, 'second.jsonl'), '--silent')).toEqual(first);
        expect(fs.readFileSync(path.join(dir, 'effect.txt'), 'utf8')).toBe('original');
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

    it.each(['--store=file', '--store-module=file', '--record=file', '--replay=file', '--checkpoint=file',
        '--resume=file', '--answer-for=id', '--answer=value', '--answer-file=file', '--answre-file=file',
        '--trace=', '--trace'])('rejects removed or invalid option %s', option => {
        const result = spl('success(1);', option, '--silent');
        expect(result).toMatchObject({ code: 2, out: '' });
        expect(result.err).toContain('spl:');
    });

    it('advertises only the consolidated trace interface', () => {
        const help = run(['--help']).out;
        expect(help).toContain('--trace <file.jsonl>');
        expect(help).toContain('Reuse the same path to resume');
        for (const option of ['--store', '--record', '--replay', '--checkpoint', '--resume', '--answer']) {
            expect(help).not.toContain(option);
        }
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
        const file = path.join(dir, 's.md');
        fs.writeFileSync(file, workflow(asking));
        const result = run([file, ...args, '--silent'], env);
        expect(result).toMatchObject({ code: 1, err: '' });
        expect(JSON.parse(result.out)).toEqual({ status: 'failure', reason, command: asking, line: 7, status_code: 'llm_error' });
    });

    it('applies the frontmatter model, --model precedence and saved-credential checks to blockquotes', () => {
        const file = path.join(dir, 's.md');
        fs.writeFileSync(file, `${document(`${fence('const value = 20;')}\n\n> Double @value and save it to @doubled`, "model: 'gemini-test'\n")}\n`);
        const quoted = run([file, '--silent']);
        expect(quoted.code).toBe(1);
        expect(JSON.parse(quoted.out)).toEqual({
            status: 'failure', reason: 'no API key for google; set GOOGLE_GENERATIVE_AI_API_KEY or run spl login google',
            command: '> Double @value and save it to @doubled', line: 11, status_code: 'llm_error',
        });
        expect(JSON.parse(run([file, '--model', 'gpt-test', '--silent']).out)).toMatchObject({ reason: expect.stringContaining('no API key for openai') });
        fs.mkdirSync(path.join(dir, 'spl-home'));
        fs.writeFileSync(path.join(dir, 'spl-home', 'credentials.json'), 'not json');
        expect(JSON.parse(run([file, '--silent']).out)).toMatchObject({
            status_code: 'llm_error', reason: 'cannot read saved credentials: invalid JSON; run spl logout to remove them',
        });
    });

    it('logs the failed call and its reason on stderr unless silent', () => {
        const result = spl(asking);
        expect(result.code).toBe(1);
        expect(result.err).toMatch(/^-> input ask /);
        expect(result.err).toContain('\n\nHi\n');
        expect(result.err).toContain('x error llm_error: no provider configured');
        expect(result.err.trimEnd().endsWith('(line 7)')).toBe(true);
    });

    it('rejects an unknown --provider as a usage error before running', () => {
        const result = spl("await writeFile('ran.txt', 'x');", '--provider', 'nope');
        expect(result).toMatchObject({ code: 2, out: '', err: expect.stringContaining("spl: unknown provider 'nope'; expected openai, anthropic, google") });
        expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false);
    });
});

describe('cli', () => {
    it('prints help and the package version', () => {
        const help = run(['-h', path.join(dir, 'missing.md')]);
        expect(help).toMatchObject({ code: 0, err: '' });
        expect(help.out).toMatch(/^spl - Semantic Prompt Language: executable Markdown workflows in JavaScript\n\nUsage: spl <workflow\.md> \[options\]\n/);
        expect(help.out).toContain('Exit codes: 0 success, 1 uncaught script failure, 2 syntax or usage error,\n70 internal/infrastructure error.\n');
        for (const flag of ['--version', '-v']) expect(run([flag])).toEqual({ code: 0, out: `${VERSION}\n`, err: '' });
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

    it.each([undefined, 'error', 'info'] as const)('hides state changes at %s verbosity without changing results', level => {
        const result = spl('const items = [];\nitems.push(1);\nsuccess(items);', ...(level ? ['--log-level', level] : []));
        expect(result).toEqual({ code: 0, out: '[\n  1\n]\n', err: '' });
    });

    it.each([
        [undefined, undefined, 'xterm', false], ['1', undefined, 'xterm', true],
        ['0', undefined, 'xterm', false], ['1', '1', 'xterm', false],
        [undefined, undefined, 'dumb', false], ['1', undefined, 'dumb', true],
    ])('keeps redirected output append-only with FORCE_COLOR=%s NO_COLOR=%s TERM=%s', (force, noColor, term, color) => {
        const file = path.join(dir, 'colors.md');
        fs.writeFileSync(file, workflow("const n = 1;\nlog('hi');\nsuccess(n);"));
        const result = run([file], { FORCE_COLOR: force, NO_COLOR: noColor, TERM: term });
        expect(result).toMatchObject({ code: 0, out: '1\n' });
        expect(result.err.includes('\u001b[')).toBe(color);
        expect(result.err.replace(/\u001b\[[\d;]*m/g, '')).not.toContain('\u001b');
        expect(result.err.replace(/\u001b\[[\d;]*m/g, '')).toContain('[info] log: hi\n');
        expect(result.err).not.toContain('Enter/Space');
    });

    it('never loads native UI, spawns renderers or acquires input for excluded invocations and library sinks', () => {
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
registerHooks({ resolve(specifier, context, next) { if (specifier.startsWith('@bettertui/')) { record('native'); throw new Error('test native forbidden'); } return next(specifier, context); } });`),
        };
        const file = path.join(dir, 'excluded.md');
        fs.writeFileSync(file, workflow("success(await human('question'));"));
        for (const args of [['--help'], ['--version'], ['logout'], [file, '--check']]) {
            expect(run(args, env)).toMatchObject({ code: 0, err: '' });
        }
        fs.writeFileSync(file, workflow('const n = 1;\nsuccess(n);'));
        expect(run([file, '--silent'], env)).toEqual({ code: 0, out: '1\n', err: '' });
        const library = spawnSync(process.execPath, ['--input-type=module', '-e',
            `import { Logger } from ${JSON.stringify(dist('index.js'))}; new Logger('info', () => {}).info('embedded');`],
        { encoding: 'utf8', env: { ...process.env, ...env } });
        expect(library.status).toBe(0);
        expect(fs.existsSync(marker)).toBe(false);
    });

    it('rejects raw scripts and Markdown without the exact opt-in', () => {
        for (const name of ['legacy.spl', 'script.js']) {
            const raw = path.join(dir, name);
            fs.writeFileSync(raw, 'success(42);');
            const result = run([raw, '--check']);
            expect(result).toMatchObject({ code: 2, out: '' });
            expect(result.err).toContain('only .md workflows are executable; put JavaScript in a fenced js block');
        }
        const file = path.join(dir, 'ordinary.md');
        for (const [source, reason] of [
            ['# Notes\n\n```js\nsuccess(42);\n```', 'Markdown workflows require YAML frontmatter'],
            [workflow('success(42);').replace('semantic-prompt-language', 'other-extension'), 'frontmatter requires extension: semantic-prompt-language'],
            [workflow('success(42);').replace('version: 1', 'version: 2'), 'frontmatter requires version: 1'],
            [workflow('success(42);').replace('version: 1', 'version: 1\nstrict: true'), "unknown frontmatter field 'strict'"],
        ]) {
            fs.writeFileSync(file, source);
            expect(run([file, '--check'])).toMatchObject({ code: 2, out: '', err: expect.stringContaining(`: syntax error: ${reason}`) });
        }
        expect(run([path.join(dir, 'missing.md')])).toMatchObject({ code: 2, out: '', err: expect.stringContaining("spl: cannot read '") });
    });

    it('checks blockquotes and their controls offline and runs shared fences in order', () => {
        const file = path.join(dir, 'mixed.md');
        const write = (body: string): void => fs.writeFileSync(file, `${document(body)}\n`);
        write(`${fence("await writeFile('ran.txt', 'x');\nconst value = await ask('Not asked');")}

${quote("@CTL(restrict={fs: ['./src'], exec: 'git'}, enforce='Be concise', model='m', reasoning='high')\nDouble @value.")}

> @CODEGEN 'Define double(value), returning value * 2'`);
        expect(run([file, '--check'])).toEqual({ code: 0, out: '', err: '' });
        expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false);
        for (const [control, mode] of [
            ['@CTL(model=42) Double @value.', '--check'],
            ['@CTL(model=42) Double @value.', '--silent'],
            ['@CTL(colour="red") Double @value.', '--check'],
            ["@CTL(restrict={disk: './src'}) Double @value.", '--check'],
        ]) {
            write(`${fence("await writeFile('ran.txt', 'x');")}\n\n${quote(control)}`);
            expect(run([file, mode])).toMatchObject({ code: 2, out: '', err: expect.stringMatching(/mixed\.md:10:\d+: syntax error: @CTL/) });
        }
        expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false);
        write(`${fence('let value = 20;\nfunction double(n) {\n    return n * 2;\n}')}\n\nIgnored prose\n\n${fence('value = double(value);\nsuccess(value + 2);')}`);
        expect(run([file, '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
    });

    it('passes repeated --arg values in order before and after the script path', () => {
        const file = path.join(dir, 'args.md');
        fs.writeFileSync(file, workflow('success([args, args[0], args[3], args.length, Object.isFrozen(args)]);'));
        const result = run(['--arg=first', file, '--arg', 'two words', '--silent', '--arg=--model=x']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out)).toEqual([['first', 'two words', '--model=x'], 'first', null, 3, true]);
        expect(result.err).toBe('');
    });

    it('supports empty arguments and defaults to an empty argument list', () => {
        expect(JSON.parse(spl('success([args, args[0] ?? null]);', '--silent').out)).toEqual([[], null]);
        expect(JSON.parse(spl('success([args[0], args[1] ?? null]);', '--arg=', '--silent').out)).toEqual(['', null]);
        expect(spl('success(1);', '--arg').code).toBe(2);
        expect(spl('success(args[0]);', '--arg=x', '--check')).toEqual({ code: 0, out: '', err: '' });
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
        expect(fs.existsSync(path.join(dir, 'out'))).toBe(false);
        const outside = spl(copying, '--silent');
        expect(outside.code).toBe(1);
        expect(JSON.parse(outside.out)).toMatchObject({ status_code: 'tool_error', line: 7 });
        const blocked = spl("await restrict('./out', async () => {\n    await writeFile('./elsewhere.txt', 'x');\n});", '--cwd', base, '--silent');
        expect(blocked.code).toBe(1);
        expect(JSON.parse(blocked.out)).toMatchObject({
            status_code: 'restriction_violation', line: 8, command: "await writeFile('./elsewhere.txt', 'x');",
            reason: expect.stringContaining(path.join(base, 'out')),
        });
        expect(fs.existsSync(path.join(base, 'elsewhere.txt'))).toBe(false);
    });

    it('prints the success value to stdout and logs to stderr', () => {
        const r = spl("log('hi');\nlog.error('bad');\nlog.debug('hidden');\nsuccess('done');");
        expect(r.code).toBe(0);
        expect(r.out).toBe('done\n');
        expect(r.err).toContain('[info] log: hi');
        expect(r.err).toContain('bad');
        expect(r.err).not.toContain('hidden');
    });

    it('prints nothing without success() and rejects a top-level return', () => {
        expect(spl('const a = 41;\na + 1', '--silent')).toEqual({ code: 0, out: '', err: '' });
        expect(spl('success();', '--silent')).toEqual({ code: 0, out: 'null\n', err: '' });
        const returned = spl('const a = 41;\nreturn a + 1;');
        expect(returned).toMatchObject({ code: 2, out: '' });
        expect(returned.err).toMatch(/s\.md:8:1: syntax error: 'return' outside of function/);
    });

    it('prints non-string results as JSON', () => {
        expect(JSON.parse(spl('success({ a: [1, null, true], skipped: undefined, half: 0.5, empty: [] });').out)).toEqual({ a: [1, null, true], half: 0.5, empty: [] });
        expect(spl('success(false);', '--silent').out).toBe('false\n');
    });

    it('pretty-prints and colors JSON logs on stderr without changing stdout', () => {
        const file = path.join(dir, 'pretty.md');
        fs.writeFileSync(file, workflow("const review = { findings: [{ severity: 'high', line: 12 }] };\nlog('review:', review);\nsuccess(review);"));
        const plain = run([file]);
        const colored = run([file], { FORCE_COLOR: '1' });
        expect(plain.code).toBe(0);
        expect(colored.code).toBe(0);
        expect(colored.out).toBe(plain.out);
        expect(JSON.parse(colored.out)).toEqual({ findings: [{ severity: 'high', line: 12 }] });
        expect(colored.out).not.toContain('\u001b[');
        expect(plain.err).not.toContain('\u001b[');
        expect(colored.err).toContain('\u001b[36m"findings"\u001b[0m');
        expect(stripVTControlCharacters(colored.err)).toBe(plain.err);
        expect(plain.err).toContain('[info] log: review:\n{\n  "findings": [');
        expect(plain.err).not.toContain('[deterministic]');
        expect(run([file, '--silent'], { FORCE_COLOR: '1' }).err).toBe('');
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
        expect(syntax.err).toContain('x error ');
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

    it('prints the failure payload to stdout and exits non-zero', () => {
        const r = spl("const a = 1;\nfail('nope');", '--silent');
        expect(r.code).toBe(1);
        expect(r.err).toBe('');
        expect(r.out).toBe(JSON.stringify({ status: 'failure', reason: 'nope', command: "fail('nope');", line: 8, status_code: 'explicit_failure' }, null, 4) + '\n');
        const logged = spl("const a = 1;\nfail('nope');");
        expect(logged.out).toBe(r.out);
        expect(logged.err).toBe('x error explicit_failure: nope (line 8)\n');
    });

    it.each([
        ['assert(1 + 1 === 3, `sum is ${1 + 1}`);', 'assertion_failed', 'sum is 2', 7],
        ['const data = null;\ndata.field;', 'runtime_error', "TypeError: Cannot read properties of null (reading 'field')", 8],
        ["function parse(text) {\n    return JSON.parse(text);\n}\nparse('{');", 'runtime_error', expect.stringMatching(/^SyntaxError: /), 8],
        ["await readFile('./missing.txt');", 'tool_error', expect.stringContaining('missing.txt'), 7],
        ["int.parse('1');", 'validation_failed', '$: expected int, got "1"', 7],
        ["throw new Failure('explicit_failure', 'thrown');", 'explicit_failure', 'thrown', 7],
    ])('reports the uncaught failure of %j as %s with exit code 1', (code, status, reason, line) => {
        const r = spl(code, '--silent');
        expect(r).toMatchObject({ code: 1, err: '' });
        expect(JSON.parse(r.out)).toEqual({ status: 'failure', reason, command: code.split('\n')[line - 7].trim(), line, status_code: status });
    });

    it('lets workflows catch failures and finish successfully', () => {
        const r = spl("let caught;\ntry {\n    fail('first');\n} catch (error) {\n    caught = [error instanceof Failure, error.statusCode, error.reason];\n}\nsuccess(caught);", '--silent');
        expect(r).toEqual({ code: 0, out: json([true, 'explicit_failure', 'first']), err: '' });
    });

    const descending = "import { assert } from 'spl-lang';\nexport function descend(depth) {\n    assert(depth > 0, 'reached the bottom');\n    return descend(depth - 1);\n}\n";

    it('reports the calling line for failures raised inside a helper module', () => {
        fs.writeFileSync(path.join(dir, 'helper.js'), descending);
        const r = spl("import { descend } from './helper.js';\nconst unused = 1;\ndescend(3);", '--silent');
        expect(r).toMatchObject({ code: 1, err: '' });
        expect(JSON.parse(r.out)).toEqual({ status: 'failure', reason: 'reached the bottom', command: 'descend(3);', line: 9, status_code: 'assertion_failed' });
    });

    it('reports the calling line for failures raised more than ten frames below the fence', () => {
        fs.writeFileSync(path.join(dir, 'helper.js'), descending);
        const r = spl("import { descend } from './helper.js';\nconst unused = 1;\ndescend(12);", '--silent');
        expect(r).toMatchObject({ code: 1, err: '' });
        expect(JSON.parse(r.out)).toEqual({ status: 'failure', reason: 'reached the bottom', command: 'descend(12);', line: 9, status_code: 'assertion_failed' });
    });

    it('reports syntax errors on stderr with exit code 2 before running anything', () => {
        const file = path.join(dir, 's.md');
        const r = spl("await writeFile('ran.txt', 'x');\nconst = 1;");
        expect(r).toEqual({ code: 2, out: '', err: `x error ${file}:8:7: syntax error: Unexpected token\n` });
        expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false);
        fs.writeFileSync(file, `${document(`${fence("await writeFile('ran.txt', 'x');")}\n\n${fence('success(1;')}`)}\n`);
        expect(run([file, '--silent'])).toMatchObject({ code: 2, out: '', err: expect.stringMatching(/s\.md:11:\d+: syntax error: /) });
        expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false);
        fs.writeFileSync(file, `${document('```js\nsuccess(1);')}\n`);
        expect(run([file])).toMatchObject({ code: 2, out: '', err: expect.stringContaining('s.md:6:1: syntax error: unterminated js fence') });
    });

    it('--check only parses', () => {
        expect(spl("fail('x');", '--check')).toEqual({ code: 0, out: '', err: '' });
        expect(spl('fail(', '--check')).toMatchObject({ code: 2, out: '', err: expect.stringMatching(/s\.md:7:\d+: syntax error: /) });
    });

    it('validates call options at runtime without contacting the model', () => {
        const r = spl("success(await ask('x', { len: 'huge' }));", '--silent');
        expect(r.code).toBe(1);
        expect(JSON.parse(r.out)).toMatchObject({ status_code: 'runtime_error', reason: expect.stringContaining('len must be'), line: 7 });
        expect(JSON.parse(spl("await think('x', { seed: 1 });", '--silent').out)).toMatchObject({ status_code: 'runtime_error' });
    });

    it('rejects bad usage and the removed mock/seed options', () => {
        expect(run([])).toMatchObject({ code: 2, out: '', err: expect.stringContaining('expected exactly one script file') });
        const file = path.join(dir, 's.md');
        fs.writeFileSync(file, workflow('success(1);'));
        expect(run([file, file]).code).toBe(2);
        expect(spl('success(1);', '--log-level', 'loud')).toMatchObject({ code: 2, err: expect.stringContaining("invalid --log-level 'loud'") });
        expect(spl('success(1);', '--backend', 'mock').code).toBe(2);
        expect(spl('success(1);', '--seed', '1').code).toBe(2);
        for (const timeout of ['0', 'soon']) {
            expect(spl('success(1);', `--timeout=${timeout}`)).toMatchObject({ code: 2, out: '', err: expect.stringContaining('--timeout must be a positive number') });
        }
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

    it('lists login and logout and describes JavaScript workflows in the help', () => {
        const help = run(['--help']).out;
        expect(help).toContain('spl login');
        expect(help).toContain('spl logout');
        expect(help).toContain('--provider <name>');
        expect(help).not.toContain('--backend');
        expect(help).not.toContain('--seed');
        expect(help).toContain('--mcp <file.json>');
        expect(help).toContain('--arg <value>');
        expect(help).toContain('variable-state changes');
        expect(help).toContain('defining scopes');
        expect(help).toContain('no-op assignments');
        expect(help).toContain('Enter/Space toggle');
        expect(help).toContain('Plain/final transcripts');
        expect(help).not.toContain('[deterministic]');
        expect(help).toContain('js fences run as native JavaScript (ts fences have their types erased) with the spl-lang library');
        expect(help).toContain('--arg <value>           script argument exposed in args');
        expect(help).toContain('--cwd <dir>             base directory for imports, relative paths and restrictions');
        expect(help).toContain('--check                 validate fences, controls, relative imports and any --mcp config without executing');
        expect(help).toContain('the value passed to success()');
        expect(help).not.toMatch(/\$args|\$env|spl fence|\.spl\b/);
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

    it('validates --mcp without starting servers, including with --check', () => {
        const file = path.join(dir, 'mcp.json');
        fs.writeFileSync(file, JSON.stringify({ servers: { docs: { type: 'stdio', command: 'nonexistent-test-server' } } }));
        const r = spl('success(42);', '--mcp', file, '--silent');
        expect(r).toEqual({ code: 0, out: '42\n', err: '' });
        expect(spl('success(42);', '--mcp', file, '--check').code).toBe(0);
        fs.writeFileSync(file, '{"servers":{"docs":{"type":"http","url":42}}}');
        expect(spl('success(42);', '--mcp', file, '--check')).toMatchObject({ code: 2, out: '' });
        expect(spl('success(42);', '--mcp', path.join(dir, 'missing.json')).err).toContain('MCP config');
    });
});
