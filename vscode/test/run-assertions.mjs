// Runs the scope assertions in test/*.spl.
//
// Format (same idea as vscode-tmgrammar-test): a line starting with "#", spaces and carets asserts the scopes of the
// previous source line at the caret columns. "- scope" asserts that a scope is absent. The first line is a header.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadGrammar, root, vsctm } from './load-grammar.mjs';

const ASSERT = /^#(\s*)(\^+)\s+(.+?)\s*$/;
const grammar = await loadGrammar();
const markdown = await loadGrammar('spl.markdown.injection');
for (const fence of ['```', '~~~~']) {
    let stack = markdown.tokenizeLine(`${fence}spl`, vsctm.INITIAL).ruleStack;
    const code = markdown.tokenizeLine('let count = 42', stack);
    stack = code.ruleStack;
    assert.ok(code.tokens.some(token => token.scopes.includes('meta.embedded.block.spl') &&
        token.scopes.some(scope => scope.startsWith('keyword'))), 'SPL keywords are highlighted inside Markdown');
    stack = markdown.tokenizeLine(fence, stack).ruleStack;
    assert.equal(stack.depth, 1, 'closing fence exits embedded SPL');
}
const quote = '> Return @count using @success.';
const markers = markdown.tokenizeLine(quote, vsctm.INITIAL).tokens
    .filter(token => token.scopes.includes('variable.other.reference.spl'))
    .map(token => quote.slice(token.startIndex, token.endIndex));
assert.deepEqual(markers, ['@count', '@success']);
assert.ok(!markdown.tokenizeLine('ordinary @count', vsctm.INITIAL).tokens
    .some(token => token.scopes.includes('variable.other.reference.spl')));
const dir = path.join(root, 'test');
let failures = 0;
let checks = 0;

const hasScope = (scopes, wanted) => scopes.some((s) => s === wanted || s.startsWith(wanted + '.'));

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.spl'))) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/);
    let stack = vsctm.INITIAL;
    let tokens = [];
    let source = '';
    lines.forEach((line, i) => {
        if (i === 0 && line.startsWith('# SYNTAX TEST')) return;
        const m = ASSERT.exec(line);
        if (!m) {
            const r = grammar.tokenizeLine(line, stack);
            stack = r.ruleStack;
            tokens = r.tokens;
            source = line;
            return;
        }
        const start = m[1].length + 1;
        const end = start + m[2].length;
        const required = [];
        const forbidden = [];
        for (const part of m[3].split(/\s+/)) {
            if (part === '-') continue;
            (m[3].includes(`- ${part}`) || part.startsWith('-') ? forbidden : required).push(part.replace(/^-/, ''));
        }
        for (const t of tokens.filter((t) => t.startIndex < end && t.endIndex > start)) {
            checks++;
            const missing = required.filter((s) => !hasScope(t.scopes, s));
            const present = forbidden.filter((s) => hasScope(t.scopes, s));
            if (missing.length || present.length) {
                failures++;
                console.error(
                    `${file}:${i + 1}: '${source.slice(t.startIndex, t.endIndex)}' ` +
                        `${missing.length ? `lacks ${missing.join(', ')} ` : ''}${present.length ? `has forbidden ${present.join(', ')} ` : ''}` +
                        `(actual: ${t.scopes.slice(1).join(' ')})`,
                );
            }
        }
    });
}

if (failures) {
    console.error(`${failures} assertion(s) failed`);
    process.exitCode = 1;
} else {
    console.log(`${checks} scope assertions passed`);
}
