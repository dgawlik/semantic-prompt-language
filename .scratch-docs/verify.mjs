// Scratch verifier: writes every `spl` and `ts` listing of the documentation to a file and runs `spl check` on it.
import fs from 'node:fs';
import path from 'node:path';
import { check } from '../lang/dist/check.js';
import { compile } from '../lang/dist/compile.js';

const root = path.resolve(import.meta.dirname, '..');
const work = path.join(import.meta.dirname, 'listings');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const files = process.argv.length > 2 ? process.argv.slice(2) : [
    'README.md', 'lang/README.md',
    ...fs.readdirSync(path.join(root, 'docs-template')).filter(name => name.endsWith('.md')).map(name => `docs-template/${name}`),
];
let failed = 0;
let checked = 0;
for (const file of files) {
    const markdown = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
    let index = 0;
    for (const match of markdown.matchAll(/^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm)) {
        index++;
        const [language, flag] = match[2].trim().split(/\s+/);
        if (language !== 'spl' && language !== 'ts') continue;
        const line = markdown.slice(0, match.index).split('\n').length;
        const label = `${file}:${line} (${match[2].trim()})`;
        if (flag === 'fragment') { console.log(`skip  ${label}`); continue; }
        const text = match[3];
        try { compile(text); } catch (error) { failed++; console.log(`FAIL  ${label} compile: ${error.message}`); continue; }
        const target = path.join(work, `${path.basename(file, '.md')}-${index}.spl`);
        fs.writeFileSync(target, text);
        const problems = check(target);
        checked++;
        if (problems.length) {
            failed++;
            console.log(`FAIL  ${label}`);
            for (const problem of problems) console.log(`        ${problem.line}:${problem.column} ${problem.message}`);
        } else console.log(`ok    ${label}`);
    }
}
console.log(`${checked} listings type-checked, ${failed} failed`);
