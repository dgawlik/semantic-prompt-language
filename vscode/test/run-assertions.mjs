// Scope assertions for the Markdown injection grammar: blockquote markers, @CTL(...) settings and @CODEGEN.
// JavaScript and TypeScript fences belong to VS Code's own Markdown grammar and must stay untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { INJECTION, loadGrammar, root, tokenizeLines, vsctm } from './load-grammar.mjs';

const markdown = await loadGrammar();
let checks = 0;
const ok = (condition, message) => { checks++; assert.ok(condition, message); };
const same = (actual, expected, message) => { checks++; assert.deepEqual(actual, expected, message); };

const REFERENCE = 'variable.other.reference.spl';
const KEYWORD = 'keyword.control.spl';
const SETTING = 'variable.parameter.modifier.spl';
const tokenize = (line, stack = vsctm.INITIAL) => {
    const result = markdown.tokenizeLine(line, stack);
    const tokens = result.tokens.map(token => ({ text: line.slice(token.startIndex, token.endIndex), start: token.startIndex, end: token.endIndex, scopes: token.scopes }));
    return { tokens, stack: result.ruleStack };
};
const scoped = (tokens, scope) => tokens.filter(token => token.scopes.includes(scope)).map(token => token.text);
const has = (tokens, text, scope) => tokens.some(token => token.text === text && token.scopes.includes(scope));
const spl = token => token.scopes.some(scope => /(?:^|\.)spl(?:\.|$)/.test(scope));

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
same(manifest.contributes.grammars, [{ scopeName: INJECTION, path: './syntaxes/markdown.tmLanguage.json', injectTo: ['text.html.markdown'] }],
    'the extension contributes only the blockquote injection');
same(manifest.contributes.languages, undefined, 'the spl language is gone');
same(JSON.parse(fs.readFileSync(path.join(root, 'syntaxes', 'markdown.tmLanguage.json'), 'utf8')).scopeName, INJECTION);
for (const snippets of manifest.contributes.snippets) ok(fs.existsSync(path.join(root, snippets.path)), snippets.path);

const quote = '> Return @count using @success.';
const quoteTokens = tokenize(quote).tokens;
same(scoped(quoteTokens, REFERENCE), ['@count', '@success']);
ok(quoteTokens.find(token => token.text === 'Return ').scopes.includes('string.unquoted.blockquote.spl'), 'blockquote text uses the theme string color');
ok(quoteTokens.filter(token => token.scopes.includes(REFERENCE)).every(token => token.scopes.includes('meta.embedded.inline.spl')),
    'references reset the surrounding string color before applying the theme variable color');
ok(has(quoteTokens, '> ', 'punctuation.definition.quote.begin.spl'), 'the quote marker is punctuation');
same(scoped(tokenize('ordinary @count').tokens, REFERENCE), []);

const codegenQuote = "> @CODEGEN 'Define answer() using @literal'";
const codegenTokens = tokenize(codegenQuote).tokens;
ok(has(codegenTokens, '@CODEGEN', KEYWORD), 'CODEGEN is a control marker');
ok(has(codegenTokens, 'Define answer() using @literal', 'string.quoted.spl'), 'the codegen description is a string');
same(scoped(codegenTokens, REFERENCE), [], 'codegen descriptions are literal strings');
ok(has(tokenize('> @codegen "Define answer()"').tokens, '@codegen', KEYWORD), 'CODEGEN is case-insensitive');

const controlledQuote = "> @CTL(restrict={fs: ['./src']}, enforce='Be concise', reasoning='high') Use @count.";
const controlTokens = tokenize(controlledQuote).tokens;
ok(has(controlTokens, '@CTL', KEYWORD), 'CTL is a control marker');
for (const name of ['restrict', 'enforce', 'reasoning']) ok(has(controlTokens, name, SETTING), name);
ok(has(controlTokens, 'fs', 'variable.other.property.spl'), 'restriction keys are properties');
ok(has(controlTokens, './src', 'string.quoted.spl'), 'restriction values are strings');
ok(has(controlTokens, '(', 'punctuation.section.arguments.begin.spl') && has(controlTokens, ')', 'punctuation.section.arguments.end.spl'));
same(scoped(controlTokens, REFERENCE), ['@count'], 'variables remain highlighted after CTL closes');
for (const text of ['ordinary @CTL(model="x")', 'ordinary model="x"', '> Mention model= in prose.']) {
    ok(!tokenize(text).tokens.some(token => token.scopes.includes(KEYWORD) || token.scopes.includes(SETTING)), text);
}

let controlStack = vsctm.INITIAL;
for (const [line, value, scope] of [
    ['> @CTL(', '@CTL', KEYWORD],
    ['>     restrict={', 'restrict', SETTING],
    [">         fs: ['./src'],", 'fs', 'variable.other.property.spl'],
    [">         exec: ['git']", 'exec', 'variable.other.property.spl'],
    ['>     },', '}', 'punctuation.section.mapping.end.spl'],
    [">     reasoning='high',", 'reasoning', SETTING],
    [">     forbid='mentioning @literal (or model=)'", '@literal', 'string.quoted.spl'],
    ['> ) Use @notes.', '@notes', REFERENCE],
]) {
    const result = tokenize(line, controlStack);
    controlStack = result.stack;
    const from = line.indexOf(value);
    ok(result.tokens.some(token => token.start <= from && token.end >= from + value.length && token.scopes.includes(scope)), line);
    if (value === '@literal') same(scoped(result.tokens, REFERENCE), [], line);
}
same(tokenize('', controlStack).stack.depth, 1, 'CTL closes without leaking into later Markdown');
const incompleteControls = tokenize('> @CTL(restrict={fs: [').stack;
ok(!tokenize('ordinary @name', incompleteControls).tokens.some(token =>
    token.scopes.includes('meta.control.spl') || token.scopes.includes(REFERENCE)), 'incomplete CTL does not leak into ordinary prose');

const templateQuote = '> @CTL(enforce=`Cite @sources, never (guess)`, forbid=[`slang`]) Use @notes.';
const templateTokens = tokenize(templateQuote).tokens;
ok(has(templateTokens, 'Cite @sources, never (guess)', 'string.quoted.template.spl'), 'backtick strings are literal settings');
ok(has(templateTokens, 'slang', 'string.quoted.template.spl'), 'backtick strings work inside lists');
same(scoped(templateTokens, REFERENCE), ['@notes'], 'markers inside backtick strings are text');
let templateStack = vsctm.INITIAL;
for (const [line, expected] of [
    ['> @CTL(enforce=`First line', [['First line', 'string.quoted.template.spl']]],
    ['>     with an escaped \\` backtick', [['> ', 'punctuation.definition.quote.begin.spl'], ['\\`', 'constant.character.escape.spl']]],
    ['>     and a last line`, reasoning=`low`)', [['    and a last line', 'string.quoted.template.spl'], ['reasoning', SETTING]]],
    ['> Use @notes.', [['@notes', REFERENCE]]],
]) {
    const result = tokenize(line, templateStack);
    templateStack = result.stack;
    for (const [value, scope] of expected) ok(has(result.tokens, value, scope), `${line}: ${value}`);
    if (line.includes('escaped')) ok(result.tokens.every(token => token.scopes.includes('string.quoted.template.spl')), 'the string continues over lines');
}
same(tokenize('', templateStack).stack.depth, 1, 'a multi-line backtick string closes with its CTL');
const rawTokens = tokenize("> @CTL(forbid=r'C:\\new', enforce='it\\'s short')").tokens;
ok(has(rawTokens, 'C:\\new', 'string.quoted.raw.spl'), 'raw strings keep backslashes');
same(scoped(rawTokens, 'constant.character.escape.spl'), ["\\'"], 'only ordinary strings have escapes');

let quoteStack = vsctm.INITIAL;
for (const line of ['> First @count', '> Next @result', '>', '   > Indented @value', '> > Nested @inner']) {
    const result = tokenize(line, quoteStack);
    quoteStack = result.stack;
    ok(result.tokens.some(token => token.scopes.includes('markup.quote.spl')), line);
    same(scoped(result.tokens, REFERENCE), line.match(/@[A-Za-z_]\w*/g) ?? [], line);
}
for (const line of ['', 'ordinary @count', '`@count`', '    > @count']) {
    const result = tokenize(line, quoteStack);
    quoteStack = result.stack;
    ok(!result.tokens.some(token => token.scopes.includes('string.unquoted.blockquote.spl') || token.scopes.includes(REFERENCE)), line);
}
same(scoped(tokenize('> email@example.com @@escaped @123 \\@literal @valid_name').tokens, REFERENCE), ['@valid_name']);
for (const opener of ['```markdown', '~~~~text', '```js', '```ts', '<!--']) {
    let stack = tokenize(opener).stack;
    const result = tokenize('> Do not color @count as an instruction.', stack);
    stack = result.stack;
    ok(!result.tokens.some(token => token.scopes.includes('markup.quote.spl') || token.scopes.includes(REFERENCE)), opener);
    const closer = opener === '<!--' ? '-->' : opener.startsWith('~') ? '~~~~' : '```';
    stack = tokenize(closer, stack).stack;
    same(scoped(tokenize('> Color @count again.', stack).tokens, REFERENCE), ['@count'], opener);
}

// A whole workflow: fences keep the scopes of VS Code's Markdown grammar, whatever their code looks like.
const workflow = `---
extension: semantic-prompt-language
version: 1
---

> Summarize @notes -> @summary

\`\`\`js
const quoted = notes.split('\\n').map(line => \`> \${line} @CTL(model='x')\`).join('\\n');
> @CTL(reasoning='high') Looks like an instruction with @name
// @CODEGEN 'Not a description'
success(\`@\${summary}\`);
\`\`\`

\`\`\`ts
const total: number = quoted.length; // @total
\`\`\`

~~~javascript ignore
> @CODEGEN 'Still code'
~~~

> Return @summary using @success.`.split('\n');
const fences = { js: 'javascript', ts: 'typescript', javascript: 'javascript' };
let embedded;
for (const { line, tokens, depth } of tokenizeLines(markdown, workflow)) {
    const opener = /^(?:```|~~~)(\w+)/.exec(line)?.[1];
    if (opener || /^(?:```|~~~)$/.test(line) || embedded) {
        ok(tokens.every(token => token.scopes.includes('markup.fenced_code.block.markdown')), line);
        ok(!tokens.some(spl), `no SPL scopes inside a fence: ${line}`);
        if (opener) embedded = fences[opener];
        else if (/^(?:```|~~~)$/.test(line)) embedded = undefined;
        else ok(tokens.every(token => token.scopes.includes(`meta.embedded.block.${embedded}`)), line);
    } else if (line.startsWith('>')) {
        same(scoped(tokens, REFERENCE), line.match(/@\w+/g), line);
        same(depth, 1, line);
    } else {
        ok(!tokens.some(spl), `no SPL scopes in frontmatter or prose: ${line}`);
    }
}
same(embedded, undefined, 'every fence of the sample closes');

console.log(`${checks} scope assertions passed`);
