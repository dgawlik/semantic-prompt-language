import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { check } from '../src/check.js';
import { compile } from '../src/compile.js';
import { SplSyntaxError } from '../src/errors.js';
import { discoverEvalFiles, runEvals } from '../src/eval.js';
import { scan } from '../src/scanner.js';
import { acting, action, cleanTemp, save, scripted, silent, tempDir } from './helpers.js';

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');

vi.setConfig({ testTimeout: 30_000 });

let dir: string;
beforeEach(() => {
    dir = tempDir('spl-eval-');
});
afterEach(() => {
    cleanTemp();
});

function write(name: string, content: string): string {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function runCli(args: string[]) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        cwd: dir,
        env: {
            ...process.env,
            OPENAI_API_KEY: undefined,
            ANTHROPIC_API_KEY: undefined,
            GOOGLE_GENERATIVE_AI_API_KEY: undefined,
            GOOGLE_API_KEY: undefined,
            GEMINI_API_KEY: undefined,
            SPL_PROVIDER: undefined,
            FORCE_COLOR: undefined,
            NO_COLOR: undefined,
            SPL_HOME: path.join(dir, 'spl-home'),
        },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('eval scanner and compiler', () => {
    it('scans and compiles eval blocks in *.eval.spl files', () => {
        const source = `
const shared = 'blue';
function helper(x: string) { return x.trim(); }

eval 'Description of eval' {
  let answer = ask('Color blue in hex notation')

  ---

  judge.faithful(answer, 'color is blue', 0.99)
}
`;
        const scanned = scan(source, { eval: true });
        expect(scanned.problems).toEqual([]);
        expect(scanned.evals).toHaveLength(1);
        expect(scanned.evals[0].name).toBe('Description of eval');
        expect(() => compile(source, { eval: true })).not.toThrow();
    });

    it('rejects eval blocks and judge in non-eval .spl files', () => {
        const withEval = `
eval 'test' {
  let x = 1
  ---
  judge.faithful(x, 'is one')
}
`;
        expect(scan(withEval, { eval: false }).problems.length).toBeGreaterThan(0);

        const withJudge = `judge.faithful('a', 'b');`;
        expect(() => compile(withJudge, { eval: false })).toThrow(SplSyntaxError);
    });

    it('disambiguates JS eval(...) from eval blocks', () => {
        const source = `
const x = eval('1 + 1');
eval 'real eval' {
  const y = eval('2 + 2');
  ---
  judge.toolUse('webFetch');
}
`;
        const scanned = scan(source, { eval: true });
        expect(scanned.problems).toEqual([]);
        expect(scanned.evals).toHaveLength(1);
        expect(scanned.evals[0].name).toBe('real eval');
    });

    it('requires exactly one --- phase divider per eval block', () => {
        const missingDivider = `
eval 'no divider' {
  let x = 1
}
`;
        expect(scan(missingDivider, { eval: true }).problems.length).toBeGreaterThan(0);

        const twoDividers = `
eval 'two dividers' {
  let x = 1
  ---
  let y = 2
  ---
  judge.toolUse('webFetch')
}
`;
        expect(scan(twoDividers, { eval: true }).problems.length).toBeGreaterThan(0);
    });

    it('rejects judge calls above --- or outside eval blocks', () => {
        const above = `
eval 'above divider' {
  judge.faithful('a', 'b')
  ---
}
`;
        expect(() => compile(above, { eval: true })).toThrow(SplSyntaxError);

        const outside = `
function helper() {
  judge.faithful('a', 'b');
}
`;
        expect(() => compile(outside, { eval: true })).toThrow(SplSyntaxError);
    });
});

describe('eval runtime and judge library', () => {
    it('runs faithful evals (unawaited and awaited) and passes judge-model', async () => {
        const file = write('color.eval.spl', `
eval 'Description of eval' {
  let answer = ask('Color blue in hex notation')

  ---

  judge.faithful(answer, 'color is blue', 0.9)
}
`);
        const requests: { model?: string; prompt: string }[] = [];
        const suite = await runEvals({
            files: [file],
            cwd: dir,
            judgeModel: 'judge-model-v1',
            backendFactory: () => ({
                async call(req) {
                    requests.push({ model: req.model, prompt: req.prompt });
                    if (req.prompt.includes('Color blue')) {
                        return { text: '#0000FF', effective: {} };
                    }
                    return { text: JSON.stringify({ score: 0.95, reason: 'Hex #0000FF is blue' }), effective: {} };
                },
                async close() {},
            }),
        });

        expect(suite.pass).toBe(true);
        expect(suite.total).toBe(1);
        expect(suite.passed).toBe(1);
        expect(suite.results[0].runs[0].assertions).toEqual([
            { judge: 'faithful', pass: true, score: 0.95, reason: 'Hex #0000FF is blue' },
        ]);
        expect(requests[1].model).toBe('judge-model-v1');
        expect(requests[1].prompt).toContain('#0000FF');
    });

    it('collects all soft assertions even when earlier ones fail', async () => {
        const file = write('soft.eval.spl', `
eval 'Soft assertions' {
  let answer = { value: 42 }

  ---

  judge.faithful(answer, 'first check', 0.9)
  judge.faithful(answer, 'second check', 0.5)
}
`);
        const suite = await runEvals({
            files: [file],
            cwd: dir,
            backendFactory: () => scripted(
                JSON.stringify({ score: 0.2, reason: 'failed first' }),
                JSON.stringify({ score: 0.8, reason: 'passed second' }),
            ),
        });

        expect(suite.pass).toBe(false);
        expect(suite.failed).toBe(1);
        const assertions = suite.results[0].runs[0].assertions;
        expect(assertions).toHaveLength(2);
        expect(assertions[0].pass).toBe(false);
        expect(assertions[1].pass).toBe(true);
    });

    it('evaluates judge.toolUse with positional prefix and deep equality, ignoring failed calls', async () => {
        const file = write('tools.eval.spl', `
eval 'Tool use' {
  try {
    await readFile('missing.txt')
  } catch {}
  let answer = agent('summarize google.com')

  ---

  judge.toolUse('readFile', 'missing.txt')
  judge.toolUse('webFetch', 'https://www.google.com')
  judge.toolUse('webFetch')
  judge.faithful(answer, 'it is a search engine', 0.9)
}
`);
        const suite = await runEvals({
            files: [file],
            cwd: dir,
            backendFactory: () => ({
                async call(req) {
                    if (req.kind === 'agent') {
                        return {
                            text: 'Google is a search engine.',
                            effective: {},
                            toolResults: [
                                JSON.stringify({ tool: 'webFetch', arguments: { url: 'https://www.google.com' }, success: true, output: 'Google' }),
                            ],
                        };
                    }
                    return { text: JSON.stringify({ score: 0.95, reason: 'accurate' }), effective: {} };
                },
                async close() {},
            }),
        });

        expect(suite.pass).toBe(false);
        const assertions = suite.results[0].runs[0].assertions;
        expect(assertions[0].pass).toBe(false); // readFile failed
        expect(assertions[1].pass).toBe(true);  // webFetch matched exact url
        expect(assertions[2].pass).toBe(true);  // webFetch matched empty prefix
        expect(assertions[3].pass).toBe(true);  // faithful passed
    });

    it('supports agent(@i -> @=i) and judge.toolUse(saveVariable, i, 1)', async () => {
        const file = write('increment.eval.spl', `
eval 'Increment variable' {
  let i = 0
  agent('Increment @i save to -> @=i')

  ---

  judge.toolUse('saveVariable', 'i', 1)
}
`);
        const suite = await runEvals({
            files: [file],
            cwd: dir,
            backendFactory: () => acting(
                action('loadVariable', { name: 'i' }),
                save('i', 1),
            ),
        });

        expect(suite.pass).toBe(true);
        expect(suite.results[0].runs[0].assertions[0].pass).toBe(true);
    });

    it('supports --filter, --runs, --concurrency, and --trace', async () => {
        const file = write('sub/suite.eval.spl', `
eval 'First test' {
  let a = ask('one')
  ---
  judge.faithful(a, 'is one', 0.5)
}

eval 'Second test' {
  let b = ask('two')
  ---
  judge.faithful(b, 'is two', 0.5)
}
`);
        const discovered = discoverEvalFiles([], dir);
        expect(discovered).toEqual([file]);

        let callCount = 0;
        const suite = await runEvals({
            files: discovered,
            cwd: dir,
            filter: 'First',
            runs: 2,
            concurrency: 2,
            trace: path.join(dir, 'eval-trace'),
            backendFactory: () => ({
                async call(req) {
                    callCount++;
                    if (req.prompt.includes('Evaluate whether')) return { text: JSON.stringify({ score: 0.9, reason: 'ok' }), effective: {} };
                    return { text: '1', effective: {} };
                },
                async close() {},
            }),
        });

        expect(suite.pass).toBe(true);
        expect(suite.total).toBe(1);
        expect(suite.results[0].name).toBe('First test');
        expect(suite.results[0].runs).toHaveLength(2);
        expect(callCount).toBe(4);
        expect(fs.existsSync(path.join(dir, 'eval-trace-1.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'eval-trace-1.html'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'eval-trace-2.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'eval-trace-2.html'))).toBe(true);
    });
});

describe('CLI integration for *.eval.spl', () => {
    it('spl run rejects *.eval.spl and directs user to spl eval', () => {
        const file = write('sample.eval.spl', `
eval 'x' {
  let a = 1
  ---
  judge.toolUse('webFetch')
}
`);
        const res = runCli(['run', file]);
        expect(res.code).toBe(2);
        expect(res.err).toContain('spl eval');
    });

    it('spl check type-checks *.eval.spl files and judge.*', () => {
        const valid = write('valid.eval.spl', `
eval 'valid' {
  let answer = await ask('hi')
  ---
  judge.faithful(answer, 'greeting', 0.8)
  judge.toolUse('webFetch', 'https://example.com')
}
`);
        expect(check(valid)).toEqual([]);

        const invalid = write('invalid.eval.spl', `
eval 'invalid' {
  let answer = await ask('hi')
  ---
  judge.faithful(answer, 123)
}
`);
        expect(check(invalid).length).toBeGreaterThan(0);
    });

    it('spl eval --json discovers and reports 0 evals cleanly', () => {
        const res = runCli(['eval', '--json']);
        expect(res.code).toBe(0);
        const parsed = JSON.parse(res.out) as { pass: boolean; total: number };
        expect(parsed.pass).toBe(true);
        expect(parsed.total).toBe(0);
    });
});
