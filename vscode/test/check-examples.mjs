// Tokenizes every script in ../lang/examples with the grammar and fails on illegal scopes
// or on constructs left open at the end of the file (unbalanced strings/braces).
import fs from 'node:fs';
import path from 'node:path';
import { loadGrammar, root, vsctm } from './load-grammar.mjs';

const examples = path.resolve(root, '..', 'lang', 'examples');
const grammar = await loadGrammar();

let problems = 0;
const files = fs.readdirSync(examples).filter((f) => f.endsWith('.spl'));
for (const file of files) {
    let stack = vsctm.INITIAL;
    const lines = fs.readFileSync(path.join(examples, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
        const r = grammar.tokenizeLine(line, stack);
        for (const t of r.tokens) {
            if (t.scopes.some((s) => s.startsWith('invalid'))) {
                problems++;
                console.error(`${file}:${i + 1}: invalid token '${line.slice(t.startIndex, t.endIndex)}' (${t.scopes.at(-1)})`);
            }
        }
        stack = r.ruleStack;
    });
    if (stack.depth > 1) {
        problems++;
        console.error(`${file}: grammar still inside a construct at end of file (depth ${stack.depth})`);
    }
}
if (problems) process.exitCode = 1;
else console.log(`tokenized ${files.length} example scripts without problems`);
