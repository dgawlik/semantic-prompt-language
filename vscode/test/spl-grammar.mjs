// Scope assertions for the grammar of `.spl` files, then a check of every `.spl` workflow in ../lang/examples:
// tags, agent settings, instructions and their @markers are colored, embedded code belongs to its own
// grammar, and every block ends at its closing tag.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SPL, loadSplGrammar, root, tokenizeLines } from './load-grammar.mjs';

const grammar = await loadSplGrammar();
let checks = 0;
const ok = (condition, message) => { checks++; assert.ok(condition, message); };
const same = (actual, expected, message) => { checks++; assert.deepEqual(actual, expected, message); };

const REFERENCE = 'variable.other.reference.spl';
const SETTING = 'variable.parameter.modifier.spl';
const TAG = 'entity.name.tag.spl';
const JS = 'meta.embedded.block.javascript';
const TS = 'meta.embedded.block.typescript';
const tokenize = source => tokenizeLines(grammar, source.split('\n'));
const scoped = (tokens, scope) => tokens.filter(token => token.scopes.includes(scope)).map(token => token.text);
const has = (tokens, text, scope) => tokens.some(token => token.text === text && token.scopes.includes(scope));
const all = (tokens, scope) => tokens.every(token => token.scopes.includes(scope));
const plain = tokens => tokens.every(token => token.scopes.length === 1);

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const language = manifest.contributes.languages.find(item => item.id === 'spl');
same(language.extensions, ['.spl']);
ok(manifest.activationEvents.includes('onLanguage:spl'), 'opening a .spl file starts the extension');
const contributed = manifest.contributes.grammars.find(item => item.language === 'spl');
same([contributed.scopeName, contributed.path], [SPL, './syntaxes/spl.tmLanguage.json']);
same(contributed.embeddedLanguages, {
    [JS]: 'javascript', [TS]: 'typescript', 'meta.embedded.block.frontmatter': 'yaml', 'meta.embedded.block.json': 'json',
}, 'embedded code uses the comments, brackets and snippets of its own language');
const configuration = JSON.parse(fs.readFileSync(path.join(root, language.configuration), 'utf8'));
const folds = Object.fromEntries(Object.entries(configuration.folding.markers).map(([name, pattern]) => [name, new RegExp(pattern)]));
for (const line of ['{js}', '  {ts ignore}', "{agent model='m',", '{codegen}', '{comment}', '{lock}']) ok(folds.start.test(line), line);
for (const line of ['{/js}', '  {/agent}  ']) ok(folds.end.test(line) && !folds.start.test(line), line);
for (const line of ['{json}', 'const a = {js};', '{ js }', '{/js} x']) ok(!folds.start.test(line) && !folds.end.test(line), line);

// Frontmatter is YAML and ends at its closing line, also inside an unfinished YAML string.
const header = tokenize("---\nmodel: 'unfinished\n---\n\ntext");
ok(has(header[0].tokens, '---', 'punctuation.definition.frontmatter.begin.spl'));
ok(all(header[1].tokens, 'meta.embedded.block.frontmatter') && has(header[1].tokens, 'model', 'entity.name.tag.yaml'));
ok(has(header[2].tokens, '---', 'punctuation.definition.frontmatter.end.spl'));
same(header[2].depth, 1);
ok(plain(header[4].tokens), 'text outside blocks is not colored');
ok(plain(tokenize("\n---\nmodel: 'm'\n---")[2].tokens), 'frontmatter only opens the document');

// Commentary is a comment as a whole, including block tags written inside it.
const comment = tokenize('{comment}\nShown: {js} and @name\n{js}\nconst a = 1;\n{/js}\n  {/comment}  \n{js}');
for (const { line, tokens } of comment.slice(0, 6)) ok(all(tokens.filter(token => token.text.trim()), 'comment.block.spl'), line);
same(comment[5].depth, 1);
ok(has(comment[6].tokens, 'js', TAG), 'blocks follow commentary');

// Code blocks: the tag is a tag, the body is JavaScript or TypeScript.
const code = tokenize("{js}\nconst a = await ask('x');\n{/agent}\n  {/js} trailing\n{/js}\n\n  {ts no-run}\nconst n: number = 1;\n  {/ts}");
ok(has(code[0].tokens, '{', 'punctuation.definition.tag.begin.spl') && has(code[0].tokens, 'js', TAG) && has(code[0].tokens, '}', 'punctuation.definition.tag.end.spl'));
ok(all(code[1].tokens, JS) && has(code[1].tokens, 'const', 'keyword.js') && has(code[1].tokens, 'x', 'string.quoted.single.js'));
for (const index of [2, 3]) ok(all(code[index].tokens, JS) && !code[index].tokens.some(token => token.scopes.includes(TAG)), `only {/js} alone on a line closes: ${code[index].line}`);
ok(has(code[4].tokens, '{/', 'punctuation.definition.tag.begin.spl') && has(code[4].tokens, 'js', TAG));
same(code[4].depth, 1);
ok(has(code[6].tokens, 'ts', TAG) && has(code[6].tokens, 'no-run', 'storage.modifier.spl'));
ok(all(code[7].tokens, TS) && has(code[7].tokens, 'number', 'keyword.ts'));
same(code[8].depth, 1);
for (const opener of ['{js} const a = 1;', '{js skip}', 'const a = {js}', '{javascript}', '{JS}']) {
    const result = tokenize(`${opener}\nconst b = 2;`);
    ok(result.every(item => plain(item.tokens)) && result[1].depth === 1, `not a block: ${opener}`);
}

// A block ends at its closing tag even inside a construct the embedded grammar has not finished.
for (const unfinished of ['const text = `template', '/* comment', "{ 'object': 1"]) {
    const result = tokenize(`{js}\n${unfinished}\nmore\n{/js}\n{agent}\nUse @notes\n{/agent}`);
    ok(all(result[2].tokens, JS), unfinished);
    same([result[3].depth, scoped(result[3].tokens, TAG)], [1, ['js']], unfinished);
    same(scoped(result[5].tokens, REFERENCE), ['@notes'], unfinished);
}

// Agent blocks: literal settings in the tag, then an instruction with @markers.
const agent = tokenize(`{agent restrict={fs: ['./src'], 'exec': "git"},
       enforce=['Be concise', \`Cite @sources, never {guess}\`],
       forbid=r'C:\\new', model='it\\'s', reasoning='high'}

List files with \`git ls-files\`, mail a@b.co, keep \\@literal and @@escaped.
  Then @validate[Review] save to @review using @success

{/agent}
Use @outside`);
ok(has(agent[0].tokens, 'agent', TAG) && has(agent[0].tokens, '{', 'punctuation.definition.tag.begin.spl'));
for (const [index, names] of [[0, ['restrict']], [1, ['enforce']], [2, ['forbid', 'model', 'reasoning']]]) same(scoped(agent[index].tokens, SETTING), names);
same(scoped(agent[0].tokens, 'variable.other.property.spl'), ['fs', "'exec'"], 'restriction keys are properties');
ok(has(agent[0].tokens, './src', 'string.quoted.spl') && has(agent[0].tokens, 'git', 'string.quoted.spl'));
ok(has(agent[0].tokens, '{', 'punctuation.section.mapping.begin.spl') && has(agent[0].tokens, '}', 'punctuation.section.mapping.end.spl'), 'a restriction map does not close the tag');
ok(has(agent[1].tokens, 'Cite @sources, never {guess}', 'string.quoted.template.spl'), 'markers and braces inside strings are text');
ok(has(agent[2].tokens, 'C:\\new', 'string.quoted.raw.spl'), 'raw strings keep backslashes');
same(scoped(agent[2].tokens, 'constant.character.escape.spl'), ["\\'"], 'only ordinary strings have escapes');
ok(has(agent[2].tokens, '}', 'punctuation.definition.tag.end.spl'), 'the tag closes after its settings');
for (const index of [0, 1, 2]) {
    ok(all(agent[index].tokens.filter(token => token.text.trim()), 'meta.tag.spl'), agent[index].line);
    same(scoped(agent[index].tokens, REFERENCE), [], 'settings contain no references');
}
ok(agent[4].tokens.find(token => token.text.startsWith('List files')).scopes.includes('string.unquoted.agent.spl'), 'instructions use the theme string color');
same(scoped(agent[4].tokens, REFERENCE), [], 'addresses and escaped markers are text');
same(scoped(agent[5].tokens, REFERENCE), ['@validate', '@review', '@success']);
ok(has(agent[5].tokens, 'Review', 'entity.name.type.spl'), '@validate names a type');
ok(agent[5].tokens.filter(token => token.scopes.includes(REFERENCE)).every(token => token.scopes.includes('meta.embedded.inline.spl')),
    'references reset the surrounding string color before applying the theme variable color');
ok(!agent[5].tokens.some(token => token.scopes.includes(SETTING)), 'settings are only read in the tag');
ok(has(agent[7].tokens, 'agent', TAG));
same(agent[7].depth, 1);
ok(plain(agent[8].tokens), 'markers outside blocks are text');

const compact = tokenize("{agent}\nmodel='x' is prose here, save to @out\n{/agent}");
ok(has(compact[0].tokens, '}', 'punctuation.definition.tag.end.spl'));
same([scoped(compact[1].tokens, SETTING), scoped(compact[1].tokens, REFERENCE), compact[2].depth], [[], ['@out'], 1]);

// A tag that is still being typed colors what it can and ends with the block.
for (const unfinished of ["{agent restrict={fs: ['./src'", "{agent forbid='unterminated}", '{agent enforce=`template', "{agent model='''multi"]) {
    const result = tokenize(`${unfinished}\nSave to @notes\n{/agent}\n{js}\nconst a = 1;\n{/js}`);
    ok(has(result[0].tokens, 'agent', TAG), unfinished);
    same([result[2].depth, scoped(result[2].tokens, TAG)], [1, ['agent']], unfinished);
    ok(all(result[4].tokens, JS), unfinished);
}

// Code generation takes a literal description: markers in it are text.
const codegen = tokenize("{codegen model='m'}\nDefine answer() using @literal and model='x'\n{/codegen}");
ok(has(codegen[0].tokens, 'codegen', TAG) && has(codegen[0].tokens, 'model', SETTING));
ok(all(codegen[1].tokens, 'string.unquoted.codegen.spl'));
same([scoped(codegen[1].tokens, REFERENCE), scoped(codegen[1].tokens, SETTING), codegen[2].depth], [[], [], 1]);

// A pinned journal is JSON.
const lock = tokenize('{lock}\n{ "format": "spl-lock", "unfinished\n{/lock}\n{js}');
ok(all(lock[1].tokens, 'meta.embedded.block.json') && has(lock[1].tokens, 'format', 'string.quoted.double.json'));
same([lock[2].depth, scoped(lock[3].tokens, TAG)], [1, ['js']]);
console.log(`${checks} scope assertions passed`);

/** Checks a workflow against its structure, which is found here without the grammar. */
function check(source) {
    const problems = [];
    const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
    const tokenized = tokenizeLines(grammar, lines);
    let markers = 0;
    let blocks = 0;
    let index = lines[0] === '---' ? lines.findIndex((line, at) => at > 0 && /^(---|\.\.\.)\s*$/.test(line)) + 1 : 0;
    const problem = (at, message) => problems.push(`${at + 1}: ${message}`);
    for (; index < lines.length; index++) {
        const opening = /^[ \t]*\{(js|ts|agent|codegen|comment|lock)(?=[\s}]|$)/.exec(lines[index]);
        if (!opening) {
            if (!tokenized[index].tokens.every(token => token.scopes.length === 1)) problem(index, 'text outside a block is highlighted');
            continue;
        }
        const tag = opening[1];
        const start = index;
        const close = lines.findIndex((line, at) => at > index && new RegExp(`^[ \\t]*\\{/${tag}\\}[ \\t]*$`).test(line));
        if (close < 0) {
            problem(index, `unterminated {${tag}} block`);
            break;
        }
        blocks++;
        if (tokenized[close].depth !== 1) problem(close, `{/${tag}} does not end the block`);
        if (tag === 'comment') {
            for (let at = start; at <= close; at++) {
                if (!tokenized[at].tokens.every(token => !token.text.trim() || token.scopes.includes('comment.block.spl'))) problem(at, 'commentary is not a comment');
            }
        } else {
            for (const at of [start, close]) if (!scoped(tokenized[at].tokens, TAG).includes(tag)) problem(at, `{${tag}} tag is not highlighted`);
            // The opening tag ends where its scope does; settings may continue over lines.
            let body = start + 1;
            while (body < close && !tokenized[body - 1].tokens.some(token => token.scopes.includes('punctuation.definition.tag.end.spl'))) body++;
            if (!tokenized[body - 1].tokens.some(token => token.scopes.includes('punctuation.definition.tag.end.spl'))) problem(start, `unterminated {${tag} ...} tag`);
            const content = { js: JS, ts: TS, lock: 'meta.embedded.block.json', agent: 'string.unquoted.agent.spl', codegen: 'string.unquoted.codegen.spl' }[tag];
            for (let at = body; at < close; at++) {
                const tokens = tokenized[at].tokens.filter(token => token.text.trim());
                if (!tokens.every(token => token.scopes.includes(content))) problem(at, `{${tag}} body is not highlighted as ${content}`);
                if (tokens.some(token => token.scopes.some(scope => scope.startsWith('invalid')))) problem(at, 'invalid token');
                if (tag !== 'agent') continue;
                for (const match of lines[at].matchAll(/(?<![\w@\\])@[A-Za-z_]\w*/g)) {
                    const token = tokens.find(token => token.start <= match.index && match.index < token.end);
                    if (token?.text === match[0] && token.scopes.includes(REFERENCE)) markers++;
                    else problem(at, `marker ${match[0]} is not highlighted`);
                }
            }
        }
        index = close;
    }
    return { problems, blocks, markers };
}

// The checker itself must notice what it claims to catch.
for (const [body, expected] of [
    ["{agent forbid='unterminated}\nUse @notes\n{/agent}", /1: unterminated \{agent \.\.\.\} tag/],
    ['{js}\nconst a = 1;', /1: unterminated \{js\} block/],
    ['Prose.\n\n{js}\n{/js}', /^$/],
]) assert.match(check(body).problems.join('\n'), expected, body);
assert.deepEqual(check("---\nmodel: m\n---\n{comment}\n@x\n{/comment}\n{agent model='m',\n  reasoning='low'}\nUse @notes with @validate[Note] save to @summary\n{/agent}\n{js}\nconst a = `@x`;\n{/js}"),
    { problems: [], blocks: 3, markers: 3 });

const examples = path.resolve(root, '..', 'lang', 'examples');
const files = fs.readdirSync(examples, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.spl')).sort();
let failures = 0;
let blocks = 0;
let markers = 0;
for (const file of files) {
    const result = check(fs.readFileSync(path.join(examples, file), 'utf8'));
    blocks += result.blocks;
    markers += result.markers;
    failures += result.problems.length;
    for (const problem of result.problems) console.error(`${file}:${problem}`);
}
if (!files.length || !markers) {
    console.error(`no .spl workflows with agent blocks found in ${examples}`);
    process.exitCode = 1;
} else if (failures) {
    console.error(`${failures} problem(s) in ${files.length} example .spl workflows`);
    process.exitCode = 1;
} else {
    console.log(`checked ${files.length} example .spl workflows: ${blocks} blocks and ${markers} markers highlighted without problems`);
}
