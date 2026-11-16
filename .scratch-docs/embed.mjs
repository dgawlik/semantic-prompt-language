import fs from 'node:fs';
import { run, Logger, AiBackend, compile, documentMarkdown, SplSyntaxError } from '../lang/dist/index.js';
import * as lib from '../lang/dist/library.js';

const logger = new Logger('silent');
const backend = new AiBackend({ logger, cwd: process.cwd(), timeoutMs: 300_000 });
try {
    const result = await run(fs.readFileSync('totals.spl', 'utf8'), { backend, logger, file: 'totals.spl', args: ['5'] });
    if (result.status === 'success') console.log(result.value);
    else console.error(result.failure);
} finally {
    await backend.close();
}
const fake = {
    async call() { return { text: '4', effective: {} }; },
    async close() {},
};
console.log(await run("success(await ask('2 + 2?', { fmt: 'integer' }));", { backend: fake, logger: new Logger('silent') }));
const steps = [];
await run("const a = 1;\nfunction f() { return 2; }\nlet b = f();\nsuccess(a + b);", { backend: fake, logger, beforeStep: step => { steps.push([step.kind, step.line, step.language, step.source, JSON.stringify(step.variables())]); } });
console.log(steps);
try { await run('---\nmodle: x\noutputVar: y\n\nHi\n---', { backend: fake, logger }); } catch (e) { console.log(e instanceof SplSyntaxError, e.name, e.line, e.col, e.problems, e.format('flow.spl')); }
console.log('-----math.ts');
console.log(compile(fs.readFileSync('../lang/examples/imports/math.spl', 'utf8')).emit({ library: Object.keys(lib.library()), from: 'math.spl' }));
console.log('-----run.ts');
console.log(compile(fs.readFileSync('../lang/examples/imports/run.spl', 'utf8')).emit({ library: Object.keys(lib.library()), from: 'run.spl' }));
console.log('-----greet doc');
const md = fs.readFileSync('../docs-template/Getting-started.md', 'utf8').replace(/\r\n/g, '\n');
const greet = /```spl\n([\s\S]*?)```/.exec(md)[1];
console.log(documentMarkdown(greet));

