// Tokenizes every workflow in ../lang/examples with the Markdown injection grammar and fails when a blockquote is
// not highlighted as written: an unterminated @CTL(...) or string, a marker left uncolored, an invalid scope, or
// SPL scopes leaking into fences and prose.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadGrammar, root, tokenizeLines } from './load-grammar.mjs';

const examples = path.resolve(root, '..', 'lang', 'examples');
const grammar = await loadGrammar();
const MARKER = /(?<![\w@\\])@[A-Za-z_]\w*/g;
const scoped = (token, prefix) => token.scopes.some(scope => scope.startsWith(prefix));

/** Lines that belong to a blockquote, found without the grammar. */
function blockquoteLines(lines) {
    const quoted = new Set();
    let fence;
    let comment = false;
    lines.forEach((line, index) => {
        if (fence) {
            if (fence.test(line)) fence = undefined;
        } else if (comment) {
            comment = !line.includes('-->');
        } else if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
            const [, marker] = /^ {0,3}(`{3,}|~{3,})/.exec(line);
            fence = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
        } else if (/^ {0,3}>/.test(line)) {
            quoted.add(index);
        } else {
            comment = /<!--(?![\s\S]*-->)/.test(line);
        }
    });
    return quoted;
}

function check(source) {
    const problems = [];
    const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
    const quoted = blockquoteLines(lines);
    let blockquotes = 0;
    let markers = 0;
    let string;
    tokenizeLines(grammar, lines).forEach(({ line, tokens, depth }, index) => {
        const problem = message => problems.push(`${index + 1}: ${message}`);
        for (const token of tokens) {
            if (scoped(token, 'invalid')) problem(`invalid token '${token.text}' (${token.scopes.at(-1)})`);
            if (!quoted.has(index) && token.scopes.some(scope => scope.endsWith('.spl'))) {
                problem(`'${token.text}' outside a blockquote is highlighted as ${token.scopes.at(-1)}`);
            }
        }
        if (!quoted.has(index)) return;
        if (!tokens.some(token => token.scopes.includes('markup.quote.spl'))) problem('blockquote line is not highlighted');
        for (const match of line.matchAll(MARKER)) {
            const token = tokens.find(token => token.start <= match.index && match.index < token.end);
            const colored = token.text === match[0] && (token.scopes.includes('variable.other.reference.spl') || token.scopes.includes('keyword.control.spl'));
            if (colored) markers++;
            else if (!scoped(token, 'string.quoted.')) problem(`marker ${match[0]} is not highlighted`);
        }
        // A string opens with its quotes (and an optional r prefix) and closes with the same quotes.
        for (const token of tokens.filter(token => scoped(token, 'string.quoted.'))) {
            if (string === undefined) string = /^r?('''|"""|['"`])$/.exec(token.text)?.[1];
            else if (token.text === string && !scoped(token, 'constant.character.escape')) string = undefined;
        }
        const multiline = string !== undefined && (string.length === 3 || string === '`');
        const last = !quoted.has(index + 1);
        if (string !== undefined && (last || !multiline)) {
            problem(`unterminated string starting with ${string}`);
            string = undefined;
        }
        if (last && depth > 1) problem('unterminated @CTL(...) settings');
        if (last) blockquotes++;
    });
    return { problems, blockquotes, markers };
}

// The checker itself must notice what it claims to catch.
for (const [body, expected] of [
    ["> @CTL(enforce='Be brief'\n\nProse.", /1: unterminated @CTL\(\.\.\.\) settings/],
    ["> @CTL(enforce='Be brief) Use @notes", /1: unterminated string starting with '/],
    ['> @CTL(enforce=`Be brief\n> and kind) Use @notes', /2: unterminated string starting with `/],
    ['> @CTL(model=@name) Summarize', /1: marker @name is not highlighted/],
]) assert.match(check(body).problems.join('\n'), expected, body);
assert.deepEqual(check("> @CTL(\n>     enforce='''Be\n> brief''', forbid=[r'C:\\tmp', \"it's\"]\n> )\n> Use @notes with @validate[Note] -> @summary\n\n```js\n> @x\n```"),
    { problems: [], blockquotes: 1, markers: 4 });

const workflow = source => /^extension:\s*['"]?semantic-prompt-language['"]?\s*$/m.test(
    /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(source)?.[1] ?? '');
const files = fs.readdirSync(examples, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.md')).sort()
    .map(file => ({ file, source: fs.readFileSync(path.join(examples, file), 'utf8') }))
    .filter(({ source }) => workflow(source));
let failures = 0;
let blockquotes = 0;
let markers = 0;
for (const { file, source } of files) {
    const result = check(source);
    blockquotes += result.blockquotes;
    markers += result.markers;
    failures += result.problems.length;
    for (const problem of result.problems) console.error(`${file}:${problem}`);
}
if (!files.length || !blockquotes) {
    console.error(`no workflows with blockquotes found in ${examples}`);
    process.exitCode = 1;
} else if (failures) {
    console.error(`${failures} problem(s) in ${files.length} example workflows`);
    process.exitCode = 1;
} else {
    console.log(`checked ${files.length} example workflows: ${blockquotes} blockquotes and ${markers} markers highlighted without problems`);
}
