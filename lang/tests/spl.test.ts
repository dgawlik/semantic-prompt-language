import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmRequest } from '../src/llm.js';
import { parseMarkdown, type Workflow } from '../src/markdown.js';
import { Pin } from '../src/pin.js';
import { parseSpl, scanSpl } from '../src/spl.js';
import { run, type RunOptions, type RunResult } from '../src/workflow.js';
import { NoLlm, action, backend, cleanTemp, silent, tempDir } from './helpers.js';

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');
const block = (tag: string, body: string, settings = ''): string => `{${tag}${settings && ` ${settings}`}}\n${body}\n{/${tag}}`;
const js = (code: string): string => block('js', code);
const agent = (text: string, settings = ''): string => block('agent', text, settings);

let dir: string;
beforeEach(() => {
    dir = tempDir('spl-file-');
});
afterEach(() => {
    vi.unstubAllEnvs();
    cleanTemp();
});

const exec = (source: string, options: Partial<RunOptions> = {}): Promise<RunResult> =>
    run(parseSpl(source), { backend: new NoLlm(), logger: silent, cwd: dir, ...options });

/** Every problem of a document as `line:column message`. */
const problems = (source: string): string[] => scanSpl(source).problems.map(item => `${item.line}:${item.column} ${item.message}`);

describe('.spl document syntax', () => {
    it('reads optional frontmatter and blocks in document order', () => {
        const workflow = parseSpl(`---
model: 'custom-model'
preamble: |
  Be concise.
  Cite sources.
---

{comment}
Commentary, with {js} and {agent} shown as text.
{/comment}

{js}
const count = 1;
{/js}

{agent}
Double @count.
{/agent}

{ts}
const total: number = count;
{/ts}
`);
        expect(workflow.model).toBe('custom-model');
        expect(workflow.markdown).toEqual({ preamble: 'Be concise.\nCite sources.\n' });
        expect(workflow.steps.map(step => [step.kind, step.line])).toEqual([['code', 13], ['natural', 16], ['code', 21]]);
        expect(workflow.steps[1]).toEqual({ kind: 'natural', text: 'Double @count.', line: 16 });
        expect(workflow.steps[2]).toMatchObject({ cell: { language: 'ts', source: 'const total: number = count;' } });
    });

    it('needs no frontmatter and accepts an empty header and the Markdown opt-in fields', () => {
        expect(parseSpl(js('success(1);'))).toMatchObject({ model: undefined, markdown: { preamble: undefined } });
        expect(parseSpl(`---\n---\n${js('success(1);')}`).steps).toHaveLength(1);
        expect(parseSpl(`---\nextension: semantic-prompt-language\nversion: 1\nmodel: m\n---\n${js('success(1);')}`).model).toBe('m');
        expect(parseSpl('').steps).toEqual([]);
    });

    it.each([
        ['---\nextension: other\n---', /frontmatter requires extension: semantic-prompt-language/],
        ['---\nversion: 2\n---', /frontmatter requires version: 1/],
        ['---\nstrict: true\n---', /unknown frontmatter field 'strict'/],
        ['---\nmodel: ""\n---', /frontmatter model must be a non-empty string/],
        ['---\n- a\n---', /frontmatter must be a mapping/],
        ['---\nmodel: m', /unterminated YAML frontmatter/],
    ])('rejects invalid frontmatter: %j', (header, error) => {
        expect(() => parseSpl(`${header}\n${js('success(1);')}`)).toThrow(error);
    });

    it('handles CRLF, a byte order mark, indented tags and original line numbers', async () => {
        const source = `\uFEFF---\nmodel: m\n---\n\n  {js}\n  const value = 41;\n  {/js}\n\n\t{js}\nsuccess(value + 1);\n\t{/js}\n`.replace(/\n/g, '\r\n');
        expect(parseSpl(source).steps.map(step => step.line)).toEqual([6, 10]);
        expect(await exec(source)).toEqual({ status: 'success', value: 42, hasValue: true });
        expect(await exec(`${js('const ok = true;')}\n\n${js('\nundefinedName;')}`)).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', line: 7, command: 'undefinedName;' },
        });
    });

    it('shares one scope across js and ts blocks and skips blocks marked ignore or no-run', async () => {
        const source = [
            js('const base = 40;'),
            block('ts', 'interface Point { x: number }\nconst point: Point = { x: base };'),
            block('js', "fail('ignored');", 'ignore'),
            block('ts', "fail('no-run');", 'no-run'),
            block('comment', "{js}\nfail('commentary');\n{/js}"),
            js('success(point.x + 2);'),
        ].join('\n\n');
        expect(parseSpl(source).steps).toHaveLength(3);
        expect(await exec(source)).toEqual({ status: 'success', value: 42, hasValue: true });
    });

    it('closes a block only with its own tag alone on a line', async () => {
        const source = js("const text = `\n{/agent}\n  {/js} trailing\n`;\nconst inline = '{/js}';\nsuccess(text.split('\\n').length);");
        expect(await exec(source)).toEqual({ status: 'success', value: 4, hasValue: true });
    });

    it('compiles code before anything runs and reports the document position', () => {
        expect(() => parseSpl(`${js("await writeFile('ran.txt', 'x');")}\n\n${js('const = 1;')}`))
            .toThrow(expect.objectContaining({ name: 'SplSyntaxError', line: 6, col: 7 }));
        expect(() => parseSpl(block('ts', 'enum Color { Red }'))).toThrow(/Only erasable type syntax is supported/);
        expect(() => parseSpl(js('export default 1;'))).toThrow(/exports are not supported/);
    });

    it.each([
        ['success(42);', '1:1 text outside a block; wrap commentary in {comment} and {/comment}'],
        ['  # Title', '1:3 text outside a block; wrap commentary in {comment} and {/comment}'],
        ['{/js}', '1:1 {/js} does not close a block'],
        ['{python}\nprint(1)\n{/python}', '1:1 unknown block {python}; expected {js}, {ts}, {agent}, {codegen} or {comment}'],
        ['{JS}\n{/JS}', '1:1 unknown block {JS}; expected {js}, {ts}, {agent}, {codegen} or {comment}'],
        ['{js}\nsuccess(1);', '1:1 unterminated {js} block; close it with {/js}'],
        ['{js}\nsuccess(1);\n{/ts}', '1:1 unterminated {js} block; close it with {/js}'],
        ['{js} success(1);\n{/js}', '1:6 expected a line break after the {js} tag'],
        ['{js skip}\n{/js}', '1:1 expected {js}, {js ignore} or {js no-run}'],
        ['{comment loud}\n{/comment}', '1:1 expected {comment}'],
        ['{agent} Do it\n{/agent}', '1:9 expected a line break after the {agent} tag'],
        ['{agent\nDo it\n{/agent}', "2:4 {agent}: expected '='"],
        ["{agent model='m'\n{/agent}", '1:17 {agent}: unterminated {agent} tag'],
        ["{agent model='m\n}\n{/agent}", '1:14 {agent}: unterminated string'],
        ["{agent model=''}\n{/agent}", '1:8 {agent}: model must be a non-empty string'],
        ["{agent reasoning='extreme'}\n{/agent}", '1:8 {agent}: reasoning must be low, medium, or high'],
        ["{agent model='a', model='b'}\n{/agent}", "1:19 {agent}: duplicate setting 'model'"],
        ["{agent model='a' reasoning='low'}\n{/agent}", "1:18 {agent}: expected ','"],
        ['{agent restrict={disk: "x"}}\n{/agent}', "1:18 {agent}: unknown restriction kind 'disk'"],
        ['{agent enforce=`Use ${name}`}\n{/agent}', '1:16 {agent}: expected a literal string (no interpolation)'],
        ["{agent}\n@CTL(model='m') Do it\n{/agent}", '2:1 @CTL is not used in .spl files; write the settings in the tag: {agent restrict=..., model=...}'],
        ["{agent}\nFirst.\n  @CODEGEN 'Define f()'\n{/agent}", '3:3 @CODEGEN is not used in .spl files; write the description in a {codegen} block'],
        ['{agent}\nAsk @human first\n{/agent}', '2:5 @Human has been removed; request human input in plain language'],
        ["{agent}\n@restrict('./src') Do it\n{/agent}", '2:1 @restrict has been removed; use {agent restrict=..., enforce=..., forbid=...}'],
        ['{codegen}\n\n{/codegen}', '1:1 {codegen}: description must not be empty'],
        ["{codegen temperature='0'}\nDefine f()\n{/codegen}", "1:10 {codegen}: unknown setting 'temperature'"],
    ])('rejects %j', (source, expected) => {
        expect(problems(source)[0]).toBe(expected);
        const [position, ...message] = expected.split(' ');
        const [line, col] = position.split(':').map(Number);
        expect(() => parseSpl(source)).toThrow(expect.objectContaining({ name: 'SplSyntaxError', message: message.join(' '), line, col }));
    });

    it('leaves escaped and embedded markers to the agent', () => {
        expect(parseSpl(agent('Mention \\@CTL, user@CTL.example and @@CODEGEN literally.')).steps[0])
            .toEqual({ kind: 'natural', text: 'Mention \\@CTL, user@CTL.example and @@CODEGEN literally.', line: 1 });
    });
});

describe('.spl block tags', () => {
    it('reads the settings of an agent tag across lines without including them in the instruction', () => {
        expect(parseSpl(`{agent restrict={fs: ['./src', "./docs"], 'exec': 'git',
        net: [], mcp: ["docs/search"]},
       enforce=['Be concise', \`Cite {sources}\`],
       forbid=r'C:\\new', model='custom', reasoning='high',
}

    List the files.

    Then save them to @files
{/agent}`).steps).toEqual([{
            kind: 'natural', line: 1, text: 'List the files.\n\nThen save them to @files',
            controls: {
                restrict: { fs: ['./src', './docs'], exec: 'git', net: [], mcp: ['docs/search'] },
                enforce: ['Be concise', 'Cite {sources}'], forbid: 'C:\\new', model: 'custom', reasoning: 'high',
            },
        }]);
        expect(parseSpl('{agent }\nDo it\n{/agent}').steps[0]).toEqual({ kind: 'natural', line: 1, text: 'Do it' });
        expect(parseSpl("{agent enforce='''Keep } and\n{/agent-like} text'''}\nDo it\n{/agent}").steps[0])
            .toMatchObject({ controls: { enforce: 'Keep } and\n{/agent-like} text' }, text: 'Do it' });
    });

    it('reads a codegen block as a literal description with optional settings', () => {
        expect(parseSpl(`{codegen model='custom', reasoning='high'}
    Define answer(value).
    Return value unchanged, including @references, 'quotes' and {braces}.
{/codegen}`).steps).toEqual([{
            kind: 'natural', line: 1, codegen: true, controls: { model: 'custom', reasoning: 'high' },
            text: "Define answer(value).\nReturn value unchanged, including @references, 'quotes' and {braces}.",
        }]);
    });

    it('finds every problem and keeps later blocks while a document is being typed', () => {
        const document = scanSpl(`---\nmodel: ''\n---\nnotes\nmore notes\n\n{agent restrict={fs: [\nList files\n{/agent}\n\n{js}\nconst a = 1;\n\n{agent}\nUse @a\n{/agent}\n{oops}\n`);
        expect(document.problems.map(item => `${item.line}:${item.column} ${item.message}`)).toEqual([
            '2:1 frontmatter model must be a non-empty string',
            '4:1 text outside a block; wrap commentary in {comment} and {/comment}',
            '8:1 {agent}: expected a literal string',
            '11:1 unterminated {js} block; close it with {/js}',
            '17:1 unknown block {oops}; expected {js}, {ts}, {agent}, {codegen} or {comment}',
        ]);
        expect(document.blocks.map(item => [item.tag, item.line, item.headerEndLine, item.endLine, item.closed, item.text])).toEqual([
            ['agent', 7, 8, 9, true, ''],
            ['js', 11, 11, 13, false, 'const a = 1;\n'],
            ['agent', 14, 14, 16, true, 'Use @a'],
        ]);
    });
});

/** The same workflow in both formats; `{comment}` stands in for Markdown prose. */
const MARKDOWN = `---
extension: semantic-prompt-language
version: 1
model: 'base-model'
preamble: 'Be concise.'
---

# Totals

Prose is commentary.

\`\`\`js
const count = 2;
const Total = struct('Total', { value: int });
\`\`\`

> @CTL(restrict={fs: ['./out'], exec: 'git'}, enforce=['Be exact', 'Show work'], forbid='guessing', model='quote-model', reasoning='high')
>
> Double @count and @validate[Total] save to @total

\`\`\`ts
const doubled: number = total.value;
\`\`\`

> @CODEGEN 'Define triple(value), returning value * 3'

\`\`\`js ignore
fail('never runs');
\`\`\`

> Write @doubled to './out/total.txt'

\`\`\`js
success([doubled, triple(doubled), await ask(\`Describe \${doubled}\`, { model: 'ask-model' })]);
\`\`\`
`;
const SPL = `---
model: 'base-model'
preamble: 'Be concise.'
---

{comment}
# Totals

Prose is commentary.
{/comment}

{js}
const count = 2;
const Total = struct('Total', { value: int });
{/js}

{agent restrict={fs: ['./out'], exec: 'git'},
       enforce=['Be exact', 'Show work'], forbid='guessing',
       model='quote-model', reasoning='high'}
Double @count and @validate[Total] save to @total
{/agent}

{ts}
const doubled: number = total.value;
{/ts}

{codegen}
Define triple(value), returning value * 3
{/codegen}

{js ignore}
fail('never runs');
{/js}

{agent}
Write @doubled to './out/total.txt'
{/agent}

{js}
success([doubled, triple(doubled), await ask(\`Describe \${doubled}\`, { model: 'ask-model' })]);
{/js}
`;

/** Plays the model for the workflow above and records what the runtime sent. */
function recording() {
    const requests: LlmRequest[] = [];
    let quotes = 0;
    return { requests, ...backend(async request => {
        requests.push(request);
        if (!request.naturalLanguage) {
            return { text: request.prompt.includes('Function description') ? 'function triple(value) {\n    return value * 3;\n}' : 'four', effective: {} };
        }
        if (++quotes === 1) await request.invokeAction!(action('save_variable', { name: 'total', value: { value: 4 }, schema: 'Total' }));
        else await request.invokeAction!(action('write_file', { path: './out/total.txt', content: '4' }));
        return { text: 'Done.', effective: {} };
    }) };
}
const sent = (requests: LlmRequest[]) => requests.map(request => ({
    kind: request.kind, naturalLanguage: request.naturalLanguage ?? false, prompt: request.prompt, model: request.model,
    reasoningEffort: request.reasoningEffort, restrictions: request.restrictions.list,
}));

describe('.spl and Markdown workflows', () => {
    it('parse to the same steps apart from their line numbers', () => {
        const strip = (workflow: Workflow) => workflow.steps.map(step => step.kind === 'code'
            ? { kind: step.kind, language: step.cell.language, source: step.cell.source, code: step.cell.code, declarations: step.cell.declarations.map(item => [item.name, item.kind]) }
            : { ...step, line: 0 });
        const markdown = parseMarkdown(MARKDOWN);
        const spl = parseSpl(SPL);
        expect(strip(spl)).toEqual(strip(markdown));
        expect(spl.model).toBe(markdown.model);
        expect(spl.markdown).toEqual(markdown.markdown);
    });

    it('run identically: results, prompts, models, reasoning, restrictions and effects', async () => {
        const outcomes = [];
        for (const workflow of [parseMarkdown(MARKDOWN), parseSpl(SPL)]) {
            const model = recording();
            const result = await run(workflow, { backend: model, logger: silent, cwd: dir });
            outcomes.push({ result, sent: sent(model.requests), written: fs.readFileSync(path.join(dir, 'out', 'total.txt'), 'utf8') });
            fs.rmSync(path.join(dir, 'out'), { recursive: true });
        }
        expect(outcomes[1]).toEqual(outcomes[0]);
        expect(outcomes[1].result).toEqual({ status: 'success', value: [4, 12, 'four'], hasValue: true });
        expect(outcomes[1].sent.map(request => [request.kind, request.model, request.reasoningEffort, request.restrictions.map(item => item.kind)])).toEqual([
            ['agent', 'quote-model', 'high', ['fs', 'exec']],
            ['ask', 'base-model', 'medium', []],
            ['agent', 'base-model', 'medium', []],
            ['ask', 'ask-model', undefined, []],
        ]);
        expect(outcomes[1].sent[0].prompt).toContain('Be concise.');
        expect(outcomes[1].sent[0].prompt).toContain('- Avoid: guessing');
        expect(outcomes[1].sent[0].prompt).toContain('Blockquote:\nDouble @count and @validate[Total] save to @total');
        expect(outcomes[1].sent[1].prompt).toContain('Function description:\nDefine triple(value), returning value * 3');
    });

    it('enforces tag restrictions and reports failures at the tag', async () => {
        const model = backend(async request => {
            await request.invokeAction!(action('write_file', { path: './elsewhere.txt', content: 'x' }));
            return { text: 'Done.', effective: {} };
        });
        const result = await exec(`${js('const ready = true;')}\n\n${agent('Write a file', "restrict={fs: ['./out']}")}`, { backend: model });
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'restriction_violation', line: 5, command: "{agent restrict={fs: ['./out']}}" } });
        expect(fs.existsSync(path.join(dir, 'elsewhere.txt'))).toBe(false);
    });
});

describe('locked .spl workflows', () => {
    const source = `${js("const answer = await ask('Answer');")}\n\n${agent('Summarize @answer and save it to @summary')}\n\n${js('success([answer, summary]);')}\n`;
    const model = () => backend(async request => {
        if (request.naturalLanguage) await request.invokeAction!(action('save_variable', { name: 'summary', value: 'saved by the agent' }));
        return { text: 'captured answer', effective: {} };
    });

    async function lock(): Promise<string> {
        const pin = Pin.capture(source, { cwd: dir, args: [] });
        expect(await run(parseSpl(source), { backend: model(), logger: silent, cwd: dir, args: [], pin })).toMatchObject({ status: 'success' });
        return pin.toSpl(source);
    }

    it('replays a journal stored in a {lock} block without a model', async () => {
        const locked = await lock();
        expect(locked.startsWith(`${source}\n\n{lock}\n{\n  "format": "spl-lock"`)).toBe(true);
        expect(locked.endsWith('\n}\n{/lock}\n')).toBe(true);
        const workflow = parseSpl(locked);
        expect(workflow.markdown?.lock).toMatchObject({ format: 'spl-lock', version: 1 });
        expect(workflow.steps).toHaveLength(3);
        expect(await run(workflow, { backend: new NoLlm(), logger: silent })).toEqual({
            status: 'success', value: ['captured answer', 'saved by the agent'], hasValue: true,
        });
    });

    it('rejects edited sources, invalid journals and a second journal', async () => {
        const locked = await lock();
        expect(() => parseSpl(locked.replace("ask('Answer')", "ask('Another')"))).toThrow(/locked workflow source mismatch/);
        expect(() => parseSpl(`${source}\n{lock}\nnot json\n{/lock}\n`)).toThrow(/invalid locked workflow JSON/);
        expect(() => parseSpl(`${source}\n{lock}\n{"format":"other"}\n{/lock}\n`)).toThrow(/invalid locked workflow format/);
        expect(() => parseSpl(`${locked}\n${locked.slice(locked.indexOf('{lock}'))}`)).toThrow(/duplicate locked workflow journal/);
    });
});

describe('.spl CLI', () => {
    vi.setConfig({ testTimeout: 30_000 });
    const OFFLINE = {
        OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined, GEMINI_API_KEY: undefined, SPL_PROVIDER: undefined, FORCE_COLOR: undefined, NO_COLOR: undefined,
    };
    function cli(args: string[], input?: string) {
        const result = spawnSync(process.execPath, [CLI, ...args], {
            encoding: 'utf8', cwd: dir, input, env: { ...process.env, ...OFFLINE, SPL_HOME: path.join(dir, 'spl-home') },
        });
        return { code: result.status, out: result.stdout, err: result.stderr };
    }
    const write = (name: string, source: string): string => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, source);
        return file;
    };

    it('runs and checks .spl files, including arguments, human answers and uppercase extensions', () => {
        const file = write('flow.SPL', `${block('comment', 'Adds an argument to an answer.')}\n\n${js("const answer = await human('Number?');\nsuccess(Number(args[0]) + Number(answer));")}\n`);
        expect(cli([file, '--check'])).toEqual({ code: 0, out: '', err: '' });
        expect(cli([file, '--silent', '--arg=40', '--human=2'])).toEqual({ code: 0, out: '42\n', err: '' });
    });

    it('reports syntax errors and missing imports with exit code 2 and never runs earlier blocks', () => {
        const file = write('broken.spl', `${js("await writeFile('ran.txt', 'x');")}\n\n${agent('Do it', 'model=')}\n`);
        for (const args of [[file], [file, '--check']]) {
            expect(cli(args)).toEqual({ code: 2, out: '', err: `x error ${file}:5:14: syntax error: {agent}: expected a literal string\n` });
        }
        expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false);
        const missing = write('missing.spl', `${js("import { value } from './missing.js';")}\n`);
        expect(cli([missing, '--check'])).toMatchObject({ code: 2, out: '', err: expect.stringContaining("missing.spl:2:1: cannot find module './missing.js'") });
    });

    it('reports failures with the document line of the block', () => {
        const file = write('fails.spl', `${js('const fine = 1;')}\n\n${js("\nfail('stopped');")}\n`);
        const result = cli([file, '--silent']);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.out)).toEqual({ status: 'failure', reason: 'stopped', command: "fail('stopped');", line: 7, status_code: 'explicit_failure' });
    });

    it('pins a run into a sibling .locked.spl and replays it without effects or prompts', () => {
        const source = `${js("const approval = await human('Approve?');\nawait writeFile('effect.txt', approval);\nsuccess([approval, args]);")}\n`;
        const file = write('flow.spl', source);
        const locked = path.join(dir, 'flow.locked.spl');
        const first = cli([file, '--pin', '--silent', '--human=yes', '--arg=original']);
        expect(first).toEqual({ code: 0, out: JSON.stringify(['yes', ['original']], null, 2) + '\n', err: '' });
        expect(fs.readFileSync(file, 'utf8')).toBe(source);
        const lockedSource = fs.readFileSync(locked, 'utf8');
        expect(lockedSource.startsWith(`${source}\n\n{lock}\n`)).toBe(true);
        fs.unlinkSync(path.join(dir, 'effect.txt'));
        expect(cli([locked, '--silent'], '')).toEqual(first);
        expect(cli([locked, '--check'])).toEqual({ code: 0, out: '', err: '' });
        expect(fs.existsSync(path.join(dir, 'effect.txt'))).toBe(false);
        expect(cli([file, '--pin', '--silent', '--human=yes'])).toMatchObject({ code: 2, err: expect.stringContaining('already exists') });
        expect(cli([locked, '--human=no', '--silent'])).toMatchObject({ code: 2, err: expect.stringContaining('locked workflows cannot') });
        fs.writeFileSync(locked, lockedSource.replace('Approve?', 'Changed?'));
        expect(cli([locked, '--silent'])).toMatchObject({ code: 2, out: '', err: expect.stringContaining('locked workflow source mismatch') });
        fs.writeFileSync(locked, source);
        expect(cli([locked, '--silent'])).toMatchObject({ code: 2, err: expect.stringContaining('missing its execution journal') });
    });

    it('traces a .spl run and replays it without repeating effects', () => {
        const file = write('traced.spl', `${js("await writeFile('count.txt', (await readFile('count.txt')) + 'x');\nsuccess(await readFile('count.txt'));")}\n`);
        fs.writeFileSync(path.join(dir, 'count.txt'), '');
        expect(cli([file, '--trace=run.jsonl', '--silent'])).toEqual({ code: 0, out: 'x\n', err: '' });
        expect(cli([file, '--trace=run.jsonl', '--silent'])).toEqual({ code: 0, out: 'x\n', err: '' });
        expect(fs.readFileSync(path.join(dir, 'count.txt'), 'utf8')).toBe('x');
    });
});
