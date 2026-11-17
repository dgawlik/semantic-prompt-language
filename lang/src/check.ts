import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from './compile.js';
import { SplSyntaxError } from './errors.js';
import { CHECK_OPTIONS, DEFAULT_EXPORT, scan, sourceColumn, type Scan } from './scanner.js';

export interface CheckProblem {
    file: string;
    line: number;
    column: number;
    message: string;
}

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Scans a workflow and every `.spl` file it imports, then type-checks them with `tsc`: the generated
 * TypeScript plus `globals.d.ts`. Nothing runs. Problems are reported at `.spl` positions.
 */
export function check(file: string): CheckProblem[] {
    const entry = path.resolve(file);
    const scanned = new Map<string, Scan>();
    /** What only the compiler found in a file; reported when tsc has nothing to say about it. */
    const rejected = new Map<string, CheckProblem[]>();
    const problems: CheckProblem[] = [];
    const visit = (current: string, from?: { file: string; line: number; column: number }): void => {
        if (scanned.has(current)) return;
        let source: string;
        try {
            source = fs.readFileSync(current, 'utf8');
        } catch (error) {
            problems.push({ ...(from ?? { file: current, line: 1, column: 1 }), message: `cannot read '${current}': ${(error as Error).message}` });
            return;
        }
        const isEval = /\.eval\.spl$/i.test(current);
        const result = scan(source, { eval: isEval });
        scanned.set(current, result);
        if (result.problems.length) {
            problems.push(...result.problems.map(problem => ({ file: current, line: problem.line, column: problem.column, message: problem.message })));
            return;
        }
        try {
            for (const item of compile(source, { eval: isEval }).imports) {
                if (/^\.{1,2}\/.*\.spl$/.test(item.specifier)) visit(path.resolve(path.dirname(current), item.specifier), { file: current, line: item.line, column: item.column });
            }
        } catch (error) {
            // TypeScript explains most of what the compiler rejects, and explains it better.
            if (!(error instanceof SplSyntaxError)) throw error;
            rejected.set(current, error.problems.map(problem => ({ file: current, ...problem })));
        }
    };
    visit(entry);
    if (problems.length) return problems;

    const files = [...scanned.keys()];
    let root = path.dirname(entry);
    while (files.some(item => path.relative(root, item).startsWith('..'))) root = path.dirname(root);
    const require = createRequire(import.meta.url);
    let tsc: string;
    let nodeTypes: string | undefined;
    try {
        tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
    } catch {
        return [{ file: entry, line: 1, column: 1, message: 'spl check needs TypeScript: run `npm install typescript`' }];
    }
    try {
        nodeTypes = path.dirname(path.dirname(require.resolve('@types/node/package.json')));
    } catch {
        nodeTypes = undefined;
    }
    // The generated files sit in a folder inside the project: `rootDirs` makes their relative imports
    // resolve as if they were beside the sources, and packages resolve by walking up from there.
    const work = fs.mkdtempSync(path.join(root, '.spl-check-'));
    try {
        const generated = new Map<string, string>();
        for (const [source, result] of scanned) {
            const target = path.join(work, `${path.relative(root, source)}.ts`);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, `${result.code}\n${DEFAULT_EXPORT}\n`);
            generated.set(path.normalize(target).toLowerCase(), source);
        }
        const typeRoots = [path.join(root, 'node_modules', '@types'), ...(nodeTypes ? [nodeTypes] : [])];
        fs.writeFileSync(path.join(work, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {
                ...CHECK_OPTIONS, rootDirs: [root, work], typeRoots,
                paths: {
                    'spl-lang': [path.join(packageRoot, 'dist', 'index.d.ts')],
                    'spl-lang/markdown': [path.join(packageRoot, 'dist', 'markdown-lib.d.ts')],
                    'spl-lang/globals': [path.join(packageRoot, 'globals.d.ts')],
                },
            },
            files: [path.join(packageRoot, 'globals.d.ts'), ...files.map(source => `${path.relative(root, source)}.ts`)],
        }));
        const result = spawnSync(process.execPath, [tsc, '-p', work, '--pretty', 'false'], { cwd: work, encoding: 'utf8' });
        if (result.error) return [{ file: entry, line: 1, column: 1, message: `cannot run tsc: ${result.error.message}` }];
        for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
            const located = /^(.+?)\((\d+),(\d+)\): error TS\d+: (.*)$/.exec(line);
            const general = /^error TS\d+: (.*)$/.exec(line);
            if (located) {
                const reported = path.resolve(work, located[1]);
                const source = generated.get(path.normalize(reported).toLowerCase());
                const [row, column] = [Number(located[2]), Number(located[3])];
                const lines = source ? scanned.get(source)!.lines : [];
                // A statement the file leaves unfinished is reported on the declaration appended after it.
                problems.push(!source ? { file: reported, line: row, column, message: located[4] }
                    : row > lines.length ? { file: source, line: lines.length, column: lines[lines.length - 1].length + 1, message: located[4] }
                    : { file: source, line: row, column: sourceColumn(scanned.get(source)!, row, column), message: located[4] });
            } else if (general) problems.push({ file: entry, line: 1, column: 1, message: general[1] });
            else if (/^\s+\S/.test(line) && problems.length) problems.at(-1)!.message += ` ${line.trim()}`;
        }
        for (const [source, found] of rejected) {
            if (!problems.some(problem => problem.file === source)) problems.push(...found);
        }
        if (result.status !== 0 && !problems.length) {
            problems.push({ file: entry, line: 1, column: 1, message: `tsc failed: ${(result.stderr || result.stdout).trim() || `exit code ${result.status}`}` });
        }
        return problems;
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}
