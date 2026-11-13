import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
    CompletionItemKind, CompletionRequest, CompletionResolveRequest, CompletionTriggerKind, createProtocolConnection,
    DefinitionRequest, DiagnosticSeverity, DidChangeTextDocumentNotification, DidOpenTextDocumentNotification,
    DocumentSymbolRequest, ExitNotification, HoverRequest, InitializedNotification, InitializeRequest,
    PublishDiagnosticsNotification, RenameRequest, ShutdownRequest, SignatureHelpRequest, StreamMessageReader,
    StreamMessageWriter, SymbolKind, type Position, type PublishDiagnosticsParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { library as catalog } from '../src/catalog';
import {
    completions, definition, diagnostics, documentHighlights, documentSymbols, hover, prepareRename, references, rename,
    resolveCompletion, signatureHelp, workflowContext, type WorkflowContext,
} from '../src/languageFeatures';
import { defaultResources, TypeScriptProject } from '../src/typescriptService';
import { analyzeWorkflow } from '../src/workflow';
import { library } from '../../lang/src/library.js';

const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'spl-language-server-')));
after(() => rmSync(base, { recursive: true, force: true }));
writeFileSync(path.join(base, 'helpers.js'), '/** Doubles a number. */\nexport function twice(value) { return value * 2; }\nexport const LIMIT = 10;\n');
mkdirSync(path.join(base, 'node_modules', 'left-pad-ish'), { recursive: true });
writeFileSync(path.join(base, 'node_modules', 'left-pad-ish', 'package.json'), '{"name":"left-pad-ish","type":"module","exports":"./index.js"}');
writeFileSync(path.join(base, 'node_modules', 'left-pad-ish', 'index.js'), 'export function pad(text, width) { return String(text).padStart(width); }\n');

const project = new TypeScriptProject(base, defaultResources(__dirname));
const uri = pathToFileURL(path.join(base, 'workflow.md')).href;
const header = '---\nextension: semantic-prompt-language\nversion: 1\nmodel: test-model\n---\n\n';
const fence = (code: string, language = 'js') => `\`\`\`${language}\n${code}\n\`\`\``;
let version = 0;
let previous: WorkflowContext | undefined;

/** Opens a workflow body; `|` marks the cursor and is removed. */
function open(body: string): { context: WorkflowContext; position: Position; source: string } {
    const marked = header + body;
    const cursor = marked.indexOf('|');
    const source = cursor < 0 ? marked : marked.slice(0, cursor) + marked.slice(cursor + 1);
    const document = TextDocument.create(uri, 'markdown', ++version, source);
    previous = workflowContext(document, project, previous);
    assert.ok(previous, 'document is a workflow');
    return { context: previous, position: document.positionAt(Math.max(0, cursor)), source };
}
const at = (source: string, text: string, offset = 0): Position => {
    const index = source.indexOf(text);
    assert.ok(index >= 0, `'${text}' not found`);
    return TextDocument.create(uri, 'markdown', 0, source).positionAt(index + offset);
};
const labels = (body: string) => {
    const { context, position } = open(body);
    return completions(context, position).map(item => item.label);
};
const hoverText = (body: string): string => {
    const { context, position } = open(body);
    const result = hover(context, position);
    return result && typeof result.contents === 'object' && 'value' in result.contents ? result.contents.value : '';
};

test('the catalog and the ambient declarations cover exactly the fence globals', () => {
    const names = Object.keys(library()).sort();
    assert.deepEqual(Object.keys(catalog).sort(), names);
    const { context } = open(fence('const probe = 1;'));
    const globals = context.project.service.getProgram()!.getSourceFile(path.join(defaultResources(__dirname).spl, 'globals.d.ts'))!.text;
    const declared = [...globals.matchAll(/^    const ([A-Za-z_$][\w$]*):/gm)].map(match => match[1]).sort();
    assert.deepEqual(declared, names);
});

test('non-workflow Markdown is left alone', () => {
    const analysis = analyzeWorkflow(TextDocument.create(uri, 'markdown', 1, '# Notes\n\n```js\nconst = 1;\n```\n'));
    assert.equal(analysis.workflow, false);
    assert.deepEqual(analysis.diagnostics, []);
});

test('fences complete the pre-imported library, JavaScript globals and earlier declarations', () => {
    const names = labels(`${fence('const notes = "raw";\nfunction shout(text) { return text.toUpperCase(); }')}\n\n${fence('|')}`);
    for (const name of ['ask', 'agent', 'restrict', 'struct', 'markdown', 'notes', 'shout', 'console', 'Promise', 'process', 'JSON']) {
        assert.ok(names.includes(name), name);
    }
    assert.ok(!names.includes('document'), 'browser globals are not offered');
});

test('members are typed: library results, schema inference, strings and Node.js modules', () => {
    assert.ok(labels(fence('const title = await ask("Title?");\ntitle.|')).includes('toUpperCase'));
    assert.ok(labels(fence('const n = await ask("How many?", { fmt: "integer" });\nn.|')).includes('toFixed'));
    const card = "const Card = struct('Card', { term: str, score: int.annotate({ minimum: 1 }) }).methods({ label() { return this.term; } });\n";
    const members = labels(fence(`${card}const card = await ask('Card', { schema: Card });\ncard.|`));
    for (const name of ['term', 'score', 'label']) assert.ok(members.includes(name), name);
    assert.ok(labels(fence(`${card}Card.|`)).includes('parse'));
    assert.ok(labels(fence('markdown.document().|')).includes('bulletList'));
    assert.ok(labels(fence("import fs from 'node:fs';\nfs.|")).includes('readFileSync'));
    assert.ok(labels(fence("import { twice } from './helpers.js';\nimport { pad } from 'left-pad-ish';\ntwice(1).|")).includes('toFixed'));
    assert.ok(labels(fence("await ask('x', { | })")).includes('repairs'));
    assert.ok(labels(fence("await ask('x', { fmt: '|' })")).includes('integer'));
});

test('completion details, hovers and signature help come from the library documentation', () => {
    const { context, position } = open(fence('restr|'));
    const item = completions(context, position).find(candidate => candidate.label === 'restrict');
    assert.ok(item);
    assert.equal(item.kind, CompletionItemKind.Constant);
    const resolved = resolveCompletion(context, item);
    assert.match(String(resolved.detail), /restrict/);
    assert.match(JSON.stringify(resolved.documentation), /Limits/);

    assert.match(hoverText(fence('await as|k("x");')), /const ask[\s\S]*Asks the model for a value/);
    assert.match(hoverText(fence('const total = 1 + 1;\nto|tal;')), /const total: number/);
    assert.equal(hoverText('Plain pro|se with ask in it.'), '');

    const help = open(fence("await writeFile('./out.txt', |)"));
    const signature = signatureHelp(help.context, help.position);
    assert.ok(signature);
    assert.match(signature.signatures[0].label, /writeFile\(path: string, content: string\)/);
    assert.equal(signature.activeParameter, 1);
    assert.equal(signatureHelp(help.context, { line: 2, character: 0 }), null);
});

test('diagnostics report workflow, control and JavaScript syntax problems with document positions', () => {
    const broken = open(`${fence('const a = ;')}\n\n> @CTL(model=42) Go\n\n${fence('return 1;')}`);
    const found = diagnostics(broken.context);
    assert.deepEqual(found.map(item => [item.range.start.line, item.message.replace(/:.*/, '')]), [
        [7, 'Unexpected token'], [13, "'return' outside of function"], [10, '@CTL'],
    ]);
    assert.ok(found.every(item => item.severity === DiagnosticSeverity.Error && item.source === 'spl'));

    assert.deepEqual(diagnostics(open(fence('const maybe = undefinedName + 1;\nmaybe.anything();')).context), []);
    const missing = diagnostics(open(fence("import { x } from './missing.js';\nimport { twice } from './helpers.js';")).context);
    assert.equal(missing.length, 1);
    assert.match(missing[0].message, /cannot find module '.\/missing.js'/);

    const frontmatter = TextDocument.create(uri, 'markdown', ++version, '---\nextension: semantic-prompt-language\nversion: 2\n---\n\n```js\nconst ok = 1;\nok.|\n```');
    const context = workflowContext(frontmatter, project, previous)!;
    previous = context;
    assert.match(diagnostics(context)[0].message, /version: 1/);
    assert.equal(context.analysis.blocks.length, 1, 'fences stay usable while the frontmatter is invalid');
});

test('ts fences are type-checked; js fences in the same document are not', () => {
    const { context, source } = open(`${fence('const loose = 1;\nloose.missing();')}\n\n${fence("const count: number = 'three';\nconst fine: string = await ask('x');\ninterface Shape { a: number }", 'ts')}`);
    assert.equal(context.analysis.language, 'ts');
    const found = diagnostics(context);
    assert.equal(found.length, 1);
    assert.equal(found[0].source, 'ts');
    assert.match(found[0].message, /Type 'string' is not assignable to type 'number'/);
    assert.deepEqual(found[0].range.start, at(source, 'count: number'));
    assert.match(diagnostics(open(fence('const x: number = ;', 'ts')).context)[0].message, /Expression expected/);
});

test('blockquotes complete shared names, library functions and markers', () => {
    const body = `${fence("const notes = 'raw';\nconst Review = struct('Review', { score: int });\nfunction shout(text) { return text; }")}\n\n> Summarize @|\n\n${fence('const later = 1;')}`;
    const names = labels(body);
    for (const name of ['notes', 'Review', 'shout', 'readFile', 'ask', 'success', 'fail', 'validate', 'env', 'args']) assert.ok(names.includes(name), name);
    for (const name of ['later', 'struct', 'restrict', 'CTL', 'console']) assert.ok(!names.includes(name), name);
    assert.deepEqual(labels(`${fence("const notes = 'raw';\nconst Review = struct('Review', { score: int });")}\n\n> Save it. @validate[|`), ['Review']);
    assert.ok(labels('> @|').includes('CTL'));
    assert.ok(labels('> @|').includes('CODEGEN'));
    const settings = labels('> @CTL(|) Go');
    assert.deepEqual(settings.sort(), ['enforce', 'forbid', 'model', 'reasoning', 'restrict']);
    assert.deepEqual(labels("> @CTL(reasoning='|') Go"), ['low', 'medium', 'high']);
    assert.deepEqual(labels("> @CTL(model='|') Go"), ['test-model']);
    assert.deepEqual(labels('Prose mentioning @|'), []);
});

test('values saved by agents are visible to later fences, typed through @validate', () => {
    const body = `${fence("const Invoice = struct('Invoice', { vendor: str, total: int });")}\n\n> Extract it. @validate[Invoice] save to @invoice, and a note -> @note\n\n${fence('invoice.|')}`;
    const members = labels(body);
    assert.ok(members.includes('vendor') && members.includes('total'));
    const { context, source } = open(body.replace('|', 'vendor;\nnote;'));
    assert.deepEqual(context.analysis.ambient.map(item => [item.name, item.schema]), [['invoice', 'Invoice'], ['note', undefined]]);
    const target = definition(context, at(source, 'invoice.vendor', 2));
    assert.deepEqual(target, [{ uri, range: { start: at(source, '@invoice', 1), end: at(source, '@invoice', 8) } }]);
    assert.match(hoverText(body.replace('invoice.|', 'inv|oice;')), /let invoice: \{\s*vendor: string;\s*total: number;?\s*\}/);
    assert.match(hoverText(`${fence('const x = 1;')}\n\n> Save to @inv|oice`), /Saved by a blockquote agent/);
});

test('definitions, references, highlights and rename connect fences and @markers', () => {
    const body = `${fence('const notes = "raw";\nfunction inner() { const notes = 1; return notes; }')}\n\n> Summarize @notes and save to @summary\n\n${fence('log(notes, summary);')}`;
    const { context, source } = open(body);
    const declaration = { uri, range: { start: at(source, 'notes'), end: at(source, 'notes', 5) } };
    assert.deepEqual(definition(context, at(source, '@notes', 3)), [declaration]);
    assert.deepEqual(definition(context, at(source, 'log(notes', 5)), [declaration]);
    const uses = references(context, at(source, 'log(notes', 5));
    assert.deepEqual(uses.map(item => item.range.start), [at(source, 'notes'), at(source, '@notes', 1), at(source, 'log(notes', 4)]);
    assert.equal(documentHighlights(context, at(source, '@notes', 2)).length, 3);
    assert.equal(references(context, at(source, 'const notes = 1', 7)).length, 2, 'a local shadow does not reach markers');

    assert.deepEqual(prepareRename(context, at(source, '@notes', 2)), {
        range: { start: at(source, '@notes', 1), end: at(source, '@notes', 6) }, placeholder: 'notes',
    });
    const edit = rename(context, at(source, 'notes'), 'draft');
    assert.equal(edit?.changes?.[uri].length, 3);
    assert.ok(edit.changes[uri].every(item => item.newText === 'draft'));
    assert.equal(rename(context, at(source, 'notes'), 'not valid'), null);
    assert.equal(prepareRename(context, at(source, 'log(notes')), null, 'library names cannot be renamed');
    assert.equal(rename(context, at(source, '@summary', 2), 'digest')?.changes?.[uri].length, 2);

    const external = definition(open(fence("import { twice } from './helpers.js';\ntwi|ce(2);")).context, previous!.virtual.positionAt(0));
    assert.deepEqual(external, []);
    const imported = open(fence("import { twice } from './helpers.js';\ntwice(2);"));
    const jump = definition(imported.context, at(imported.source, 'twice(2)', 2));
    assert.equal(jump[jump.length - 1].uri, pathToFileURL(path.join(base, 'helpers.js')).href);
});

test('document symbols list the declarations of every fence', () => {
    const { context } = open(`${fence('const notes = 1;\nfunction shout() {}\nclass Card { label() {} }')}\n\n> Save to @summary\n\n${fence('let later = 2;')}`);
    const symbols = documentSymbols(context);
    assert.deepEqual(symbols.map(item => [item.name, item.kind]), [
        ['Card', SymbolKind.Class], ['later', SymbolKind.Variable], ['notes', SymbolKind.Constant], ['shout', SymbolKind.Function],
    ]);
    assert.deepEqual(symbols[0].children?.map(item => item.name), ['label']);
});

// ---- .spl files: the same workflow in {js}, {ts}, {agent}, {codegen} and {comment} blocks ----

const splUri = pathToFileURL(path.join(base, 'workflow.spl')).href;
const block = (tag: string, body: string, settings = '') => `{${tag}${settings && ` ${settings}`}}\n${body}\n{/${tag}}`;
const js = (code: string) => block('js', code);
let previousSpl: WorkflowContext | undefined;

/** Opens a `.spl` document; `|` marks the cursor and is removed. */
function openSpl(marked: string): { context: WorkflowContext; position: Position; source: string } {
    const cursor = marked.indexOf('|');
    const source = cursor < 0 ? marked : marked.slice(0, cursor) + marked.slice(cursor + 1);
    const document = TextDocument.create(splUri, 'spl', ++version, source);
    previousSpl = workflowContext(document, project, previousSpl);
    assert.ok(previousSpl, 'a .spl document is a workflow');
    return { context: previousSpl, position: document.positionAt(Math.max(0, cursor)), source };
}
const splAt = (source: string, text: string, offset = 0): Position => {
    const index = source.indexOf(text);
    assert.ok(index >= 0, `'${text}' not found`);
    return TextDocument.create(splUri, 'spl', 0, source).positionAt(index + offset);
};
const splLabels = (body: string) => {
    const { context, position } = openSpl(body);
    return completions(context, position).map(item => item.label);
};
const splHover = (body: string): string => {
    const { context, position } = openSpl(body);
    const result = hover(context, position);
    return result && typeof result.contents === 'object' && 'value' in result.contents ? result.contents.value : '';
};

test('.spl files are workflows by their type, with or without frontmatter', () => {
    const plain = analyzeWorkflow(TextDocument.create(splUri, 'spl', 1, js('const a = 1;')));
    assert.equal(plain.workflow, true);
    assert.deepEqual(plain.blocks.map(item => [item.kind, item.line, item.endLine]), [['code', 2, 2]]);
    assert.equal(analyzeWorkflow(TextDocument.create(splUri, 'plaintext', 1, js('const a = 1;'))).workflow, true, 'the file name is enough');
    assert.equal(analyzeWorkflow(TextDocument.create('untitled:Untitled-1', 'spl', 1, '')).workflow, true, 'so is the language of an unsaved file');
    const full = analyzeWorkflow(TextDocument.create(splUri, 'spl', 1, `---\nmodel: test-model\n---\n\n${block('comment', js('const hidden = 1;'))}\n\n${block('js', 'const shown = 1;', 'ignore')}\n\n${block('agent', 'Save to @out')}\n\n${block('ts', 'const n: number = 1;')}`));
    assert.equal(full.model, 'test-model');
    assert.equal(full.language, 'ts');
    assert.deepEqual(full.blocks.map(item => [item.kind, item.spl?.tag]), [['natural', 'agent'], ['code', 'ts']]);
    assert.deepEqual(full.spl?.blocks.map(item => item.tag), ['comment', 'js', 'agent', 'ts']);
    assert.deepEqual(full.diagnostics, []);
});

test('js and ts blocks of a .spl file complete, hover and check like fences', () => {
    const names = splLabels(`${js('const notes = "raw";\nfunction shout(text) { return text.toUpperCase(); }')}\n\n${block('comment', js('const hidden = 1;'))}\n\n${js('|')}`);
    for (const name of ['ask', 'agent', 'restrict', 'struct', 'markdown', 'notes', 'shout', 'console', 'JSON']) assert.ok(names.includes(name), name);
    assert.ok(!names.includes('hidden'), 'commentary declares nothing');
    assert.ok(splLabels(js('const title = await ask("Title?");\ntitle.|')).includes('toUpperCase'));
    assert.ok(splLabels(js("import { twice } from './helpers.js';\ntwice(1).|")).includes('toFixed'));
    assert.ok(splLabels(js("await ask('x', { | })")).includes('repairs'));
    assert.match(splHover(js('await as|k("x");')), /const ask[\s\S]*Asks the model for a value/);
    assert.deepEqual(splLabels(block('js', 'const shown = 1;\nsho|', 'ignore')), [], 'blocks that do not run are not analyzed');

    const help = openSpl(js("await writeFile('./out.txt', |)"));
    assert.equal(signatureHelp(help.context, help.position)?.activeParameter, 1);

    const typed = openSpl(`${js('const loose = 1;\nloose.missing();')}\n\n${block('ts', "const count: number = 'three';")}`);
    const found = diagnostics(typed.context);
    assert.deepEqual(found.map(item => [item.source, item.range.start]), [['ts', splAt(typed.source, 'count: number')]]);
    assert.match(found[0].message, /Type 'string' is not assignable to type 'number'/);
});

test('.spl diagnostics report structure, tag settings and JavaScript problems at their positions', () => {
    const broken = openSpl(`---\nmodel: ''\n---\nstray text\n\n${js('const a = ;')}\n\n${block('agent', '@CTL(model="m") Go', 'model=42')}\n\n{python}\n\n${js("import { x } from './missing.js';")}\n\n{js}\nreturn 1;`);
    const found = diagnostics(broken.context);
    assert.deepEqual(found.map(item => [item.range.start.line, item.range.start.character, item.message]), [
        [1, 0, 'frontmatter model must be a non-empty string'],
        [3, 0, 'text outside a block; wrap commentary in {comment} and {/comment}'],
        [9, 13, '{agent}: expected a literal string'],
        [10, 0, '@CTL is not used in .spl files; write the settings in the tag: {agent restrict=..., model=...}'],
        [13, 0, 'unknown block {python}; expected {js}, {ts}, {agent}, {codegen} or {comment}'],
        [19, 0, 'unterminated {js} block; close it with {/js}'],
        [6, 10, 'Unexpected token'],
        [20, 0, "'return' outside of function"],
        [16, 0, `cannot find module './missing.js' (imports resolve against the working directory ${base})`],
    ]);
    assert.ok(found.every(item => item.severity === DiagnosticSeverity.Error && item.source === 'spl'));
    assert.deepEqual(found[4].range, { start: { line: 13, character: 0 }, end: { line: 13, character: 8 } }, 'a tag is underlined as a whole');
    assert.equal(broken.context.analysis.blocks.length, 4, 'blocks stay usable while the document has problems');
});

test('agent blocks complete shared names, library functions and markers', () => {
    const body = `${js("const notes = 'raw';\nconst Review = struct('Review', { score: int });\nfunction shout(text) { return text; }")}\n\n${block('agent', 'Summarize @|')}\n\n${js('const later = 1;')}`;
    const names = splLabels(body);
    for (const name of ['notes', 'Review', 'shout', 'readFile', 'ask', 'success', 'fail', 'validate', 'env', 'args']) assert.ok(names.includes(name), name);
    for (const name of ['later', 'struct', 'restrict', 'CTL', 'CODEGEN', 'console']) assert.ok(!names.includes(name), name);
    assert.deepEqual(splLabels(`${js("const notes = 'raw';\nconst Review = struct('Review', { score: int });")}\n\n${block('agent', 'Save it. @validate[|')}`), ['Review']);
    assert.ok(!splLabels(block('agent', '@|')).includes('CTL'), 'settings are written in the tag');
    assert.deepEqual(splLabels(block('agent', 'Mention notes|')), [], 'only @ refers to shared names');
    assert.deepEqual(splLabels(block('codegen', 'Define answer() using @|')), [], 'a description is literal');
    assert.deepEqual(splLabels(`${js('const notes = 1;')}\nStray @|`), []);
});

test('agent and codegen tags complete their settings, restriction kinds and values', () => {
    const all = ['enforce', 'forbid', 'model', 'reasoning', 'restrict'];
    assert.deepEqual(splLabels('{agent |}\nGo\n{/agent}').sort(), all);
    assert.deepEqual(splLabels('{codegen |}\nDefine f()\n{/codegen}').sort(), all);
    assert.deepEqual(splLabels("{agent model='m', |\n}\nGo\n{/agent}").sort(), ['enforce', 'forbid', 'reasoning', 'restrict']);
    assert.deepEqual(splLabels("{agent restrict={fs: ['./src'], |}}\nGo\n{/agent}").sort(), ['exec', 'mcp', 'net']);
    assert.deepEqual(splLabels("{agent restrict={fs: ['|']}}\nGo\n{/agent}"), []);
    assert.deepEqual(splLabels("{agent reasoning='|'}\nGo\n{/agent}"), ['low', 'medium', 'high']);
    assert.deepEqual(splLabels("---\nmodel: test-model\n---\n{agent model='|'}\nGo\n{/agent}"), ['test-model']);
    assert.deepEqual(splLabels('{agent|}\nGo\n{/agent}'), [], 'settings start after the tag name');
    assert.deepEqual(splLabels("{agent model='m'}|\nGo\n{/agent}"), []);

    const typing = openSpl("{agent restrict={fs: ['./src'], ex|\nList files\n{/agent}\n\n{js}\nconst kept = 1;\n{/js}");
    const [exec] = completions(typing.context, typing.position).filter(item => item.label === 'exec');
    assert.deepEqual(exec.textEdit, { range: { start: { line: 0, character: 32 }, end: { line: 0, character: 34 } }, newText: 'exec:' });
    assert.deepEqual(typing.context.analysis.blocks.map(item => item.kind), ['natural', 'code'], 'an unfinished tag does not swallow later blocks');

    assert.match(splHover("{agent restrict={fs: ['./src']}, reas|oning='high'}\nGo\n{/agent}"), /reasoning='low' \| 'medium' \| 'high'/);
    assert.match(splHover('{ag|ent}\nGo\n{/agent}'), /\{agent restrict=[\s\S]*agent command in plain language/);
    assert.match(splHover('{js}\nconst a = 1;\n{/j|s}'), /\{js\} \.\.\. \{\/js\}/);
    assert.match(splHover('{comment}\nNotes\n{/comm|ent}'), /never executed/);
    assert.equal(splHover('{agent}\nJust pro|se\n{/agent}'), '');
});

test('typing a brace between blocks offers the blocks of a .spl file', () => {
    const { context, position } = openSpl(`---\nmodel: m\n---\n\n${js('const a = 1;')}\n\n{|}\n`);
    const items = completions(context, position);
    assert.deepEqual(items.map(item => item.label), ['{js}', '{ts}', '{agent}', '{codegen}', '{comment}']);
    assert.deepEqual(items[2].textEdit, { range: { start: { line: 8, character: 0 }, end: { line: 8, character: 2 } }, newText: '{agent}\n$0\n{/agent}' });
    assert.equal(items[2].filterText, '{agent');
    assert.deepEqual(splLabels(`${js('const a = 1;')}\n\n  {ag|`), ['{js}', '{ts}', '{agent}', '{codegen}', '{comment}']);
    assert.equal(splLabels(`${js('const a = 1;')}\n\n|`).length, 5);
    for (const body of ['---\nmodel: |\n---\n', '{comment}\n{|}\n{/comment}', '{agent}\n{|}\n{/agent}', `${js('const a = 1;')}\ntext {|}`, '{js}|']) {
        assert.ok(!splLabels(body).includes('{agent}'), body);
    }
});

test('values saved by agent blocks are visible to later blocks, typed through @validate', () => {
    const body = `${js("const Invoice = struct('Invoice', { vendor: str, total: int });")}\n\n${block('agent', 'Extract it. @validate[Invoice] save to @invoice,\nand a note -> @note', "restrict={fs: ['./in']},\n       model='m'")}\n\n${js('invoice.|')}`;
    const members = splLabels(body);
    assert.ok(members.includes('vendor') && members.includes('total'));
    const { context, source } = openSpl(body.replace('|', 'vendor;\nnote;'));
    assert.deepEqual(context.analysis.ambient.map(item => [item.name, item.schema]), [['invoice', 'Invoice'], ['note', undefined]]);
    assert.deepEqual(definition(context, splAt(source, 'invoice.vendor', 2)),
        [{ uri: splUri, range: { start: splAt(source, '@invoice', 1), end: splAt(source, '@invoice', 8) } }]);
    assert.match(splHover(body.replace('invoice.|', 'inv|oice;')), /let invoice: \{\s*vendor: string;\s*total: number;?\s*\}/);
    assert.match(splHover(`${js('const x = 1;')}\n\n${block('agent', 'Save to @inv|oice')}`), /Saved by a blockquote agent/);
    assert.deepEqual(openSpl(`${block('codegen', 'Define f() and save to @generated')}\n\n${block('agent', 'Go', "forbid='saving to @quoted'")}`).context.analysis.ambient, [],
        'descriptions and settings are literal');
});

test('definitions, references, rename and symbols connect the blocks of a .spl file and @markers', () => {
    const body = `${js('const notes = "raw";\nfunction inner() { const notes = 1; return notes; }')}\n\n${block('agent', 'Summarize @notes and save to @summary')}\n\n${js('log(notes, summary);')}`;
    const { context, source } = openSpl(body);
    const declaration = { uri: splUri, range: { start: splAt(source, 'notes'), end: splAt(source, 'notes', 5) } };
    assert.deepEqual(definition(context, splAt(source, '@notes', 3)), [declaration]);
    assert.deepEqual(definition(context, splAt(source, 'log(notes', 5)), [declaration]);
    assert.deepEqual(references(context, splAt(source, 'log(notes', 5)).map(item => item.range.start),
        [splAt(source, 'notes'), splAt(source, '@notes', 1), splAt(source, 'log(notes', 4)]);
    assert.equal(documentHighlights(context, splAt(source, '@notes', 2)).length, 3);
    assert.equal(references(context, splAt(source, 'const notes = 1', 7)).length, 2, 'a local shadow does not reach markers');
    const edit = rename(context, splAt(source, 'notes'), 'draft');
    assert.equal(edit?.changes?.[splUri].length, 3);
    assert.equal(rename(context, splAt(source, '@summary', 2), 'digest')?.changes?.[splUri].length, 2);
    assert.equal(prepareRename(context, splAt(source, 'log(notes')), null, 'library names cannot be renamed');
    assert.deepEqual(documentSymbols(context).map(item => [item.name, item.kind]), [['inner', SymbolKind.Function], ['notes', SymbolKind.Constant]]);
});

test('the server speaks LSP end to end', { timeout: 60_000 }, async t => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'server.cjs'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const connection = createProtocolConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    t.after(() => { connection.dispose(); child.kill(); });
    connection.listen();
    const published: PublishDiagnosticsParams[] = [];
    let notify: (() => void) | undefined;
    connection.onNotification(PublishDiagnosticsNotification.type, params => { published.push(params); notify?.(); });
    const nextDiagnostics = async (documentVersion: number): Promise<PublishDiagnosticsParams> => {
        for (;;) {
            const found = published.find(item => item.version === documentVersion);
            if (found) return found;
            await new Promise<void>(resolve => { notify = resolve; });
        }
    };
    const initialized = await connection.sendRequest(InitializeRequest.type, {
        processId: process.pid, rootUri: pathToFileURL(base).href, capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(base).href, name: 'workspace' }],
    });
    assert.ok(initialized.capabilities.completionProvider?.resolveProvider);
    assert.ok(initialized.capabilities.renameProvider);
    await connection.sendNotification(InitializedNotification.type, {});

    const document = pathToFileURL(path.join(base, 'docs', 'flow.md')).href;
    const first = header + fence("import { twice } from './helpers.js';\nconst value = twice(2);\nvalue;\nconst = 1;");
    await connection.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri: document, languageId: 'markdown', version: 1, text: first } });
    const initial = await nextDiagnostics(1);
    assert.equal(initial.diagnostics.length, 1);
    assert.equal(initial.diagnostics[0].range.start.line, 10);

    const text = header + fence("import { twice } from './helpers.js';\nconst value = twice(2);\nvalue.\ntoFixed;\nawait writeFile('a', )") + '\n\n> Use @value and @\n';
    await connection.sendNotification(DidChangeTextDocumentNotification.type, { textDocument: { uri: document, version: 2 }, contentChanges: [{ text }] });
    assert.deepEqual((await nextDiagnostics(2)).diagnostics, []);
    const position = (needle: string, offset = 0) => TextDocument.create(document, 'markdown', 2, text).positionAt(text.indexOf(needle) + offset);

    const members = await connection.sendRequest(CompletionRequest.type, {
        textDocument: { uri: document }, position: position('value.\n', 6),
        context: { triggerKind: CompletionTriggerKind.TriggerCharacter, triggerCharacter: '.' },
    });
    const items = Array.isArray(members) ? members : members?.items ?? [];
    const toFixed = items.find(item => item.label === 'toFixed');
    assert.ok(toFixed, 'imports resolve against the workspace folder, not the document folder');
    assert.match(String((await connection.sendRequest(CompletionResolveRequest.type, toFixed)).detail), /toFixed/);
    const ignored = await connection.sendRequest(CompletionRequest.type, {
        textDocument: { uri: document }, position: position("'a', )", 5),
        context: { triggerKind: CompletionTriggerKind.TriggerCharacter, triggerCharacter: ',' },
    });
    assert.deepEqual(ignored, []);
    const shared = await connection.sendRequest(CompletionRequest.type, { textDocument: { uri: document }, position: position('and @', 5) });
    assert.ok((Array.isArray(shared) ? shared : shared?.items ?? []).some(item => item.label === 'value'));

    const info = await connection.sendRequest(HoverRequest.type, { textDocument: { uri: document }, position: position('writeFile', 2) });
    assert.match(JSON.stringify(info?.contents), /Creates or overwrites a UTF-8 text file/);
    const help = await connection.sendRequest(SignatureHelpRequest.type, { textDocument: { uri: document }, position: position("'a', )", 5) });
    assert.equal(help?.activeParameter, 1);
    const target = await connection.sendRequest(DefinitionRequest.type, { textDocument: { uri: document }, position: position('@value', 2) });
    assert.deepEqual(target, [{ uri: document, range: { start: position('value = '), end: position('value = ', 5) } }]);
    const symbols = await connection.sendRequest(DocumentSymbolRequest.type, { textDocument: { uri: document } });
    assert.ok(symbols?.some(item => item.name === 'value'));
    const edit = await connection.sendRequest(RenameRequest.type, { textDocument: { uri: document }, position: position('value = '), newName: 'result' });
    assert.equal(edit?.changes?.[document].length, 3);

    const flow = pathToFileURL(path.join(base, 'docs', 'flow.spl')).href;
    const spl = "---\nmodel: test-model\n---\n\n{js}\nimport { twice } from './helpers.js';\nconst value = twice(2);\nvalue.\ntoFixed;\n{/js}\n\n{agent reasoning=''}\nUse @value and @\n{/agent}\n\n{js}\nconst = 1;\n{/js}\n";
    await connection.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri: flow, languageId: 'spl', version: 7, text: spl } });
    const reported = (await nextDiagnostics(7)).diagnostics;
    assert.deepEqual(reported.map(item => [item.range.start.line, item.message]), [[11, '{agent}: reasoning must be low, medium, or high'], [16, 'Unexpected token']]);
    const inSpl = (needle: string, offset = 0) => TextDocument.create(flow, 'spl', 7, spl).positionAt(spl.indexOf(needle) + offset);
    const listed = async (position: Position, triggerCharacter?: string) => {
        const result = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri: flow }, position,
            ...(triggerCharacter ? { context: { triggerKind: CompletionTriggerKind.TriggerCharacter, triggerCharacter } } : {}),
        });
        return (Array.isArray(result) ? result : result?.items ?? []).map(item => item.label);
    };
    assert.ok((await listed(inSpl('value.\n', 6), '.')).includes('toFixed'), 'js blocks complete through the TypeScript service');
    assert.ok((await listed(inSpl('and @', 5), '@')).includes('value'), 'agent blocks complete shared names');
    assert.deepEqual(await listed(inSpl("reasoning=''", 11), "'"), ['low', 'medium', 'high']);
    const jump = await connection.sendRequest(DefinitionRequest.type, { textDocument: { uri: flow }, position: inSpl('@value', 2) });
    assert.deepEqual(jump, [{ uri: flow, range: { start: inSpl('value = '), end: inSpl('value = ', 5) } }]);

    await connection.sendRequest(ShutdownRequest.type);
    await connection.sendNotification(ExitNotification.type);
});
