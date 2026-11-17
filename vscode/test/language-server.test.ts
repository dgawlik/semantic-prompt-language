import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
    CompletionItemKind, CompletionRequest, CompletionResolveRequest, CompletionTriggerKind, createProtocolConnection,
    DefinitionRequest, DiagnosticSeverity, DidChangeTextDocumentNotification, DidOpenTextDocumentNotification,
    DocumentSymbolRequest, FoldingRangeRequest, HoverRequest, InitializedNotification, InitializeRequest,
    PublishDiagnosticsNotification, RenameRequest, SignatureHelpRequest, StreamMessageReader, StreamMessageWriter,
    SymbolKind, type Diagnostic, type Position, type PublishDiagnosticsParams, type Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { library } from '../../lang/src/library.js';
import { HEADER_KEYS } from '../../lang/src/scanner.js';
import { library as catalog } from '../src/catalog';
import {
    completions, definition, diagnostics, documentHighlights, documentSymbols, foldingRanges, hover, prepareRename, references, rename,
    resolveCompletion, signatureHelp, workflowContext, type WorkflowContext,
} from '../src/languageFeatures';
import { defaultResources, TypeScriptProject } from '../src/typescriptService';

const resources = defaultResources(__dirname);
const examples = path.resolve(__dirname, '..', '..', '..', 'lang', 'examples');
const base = mkdtempSync(path.join(__dirname, 'workspace-'));
after(() => rmSync(base, { recursive: true, force: true }));
writeFileSync(path.join(base, 'helpers.ts'), '/** Doubles a number. */\nexport function twice(value: number): number { return value * 2; }\nexport const LIMIT = 10;\n');
writeFileSync(path.join(base, 'legacy.js'), 'export function half(value) { return value / 2; }\n');
writeFileSync(path.join(base, 'math.spl'), [
    '//*', '# Squares', '*//', '',
    'export function square(n: number): number {', '    return n * n;', '}', '',
    'success(args.map(Number).map(square));', '',
].join('\n'));
mkdirSync(path.join(base, 'node_modules', 'left-pad-ish'), { recursive: true });
writeFileSync(path.join(base, 'node_modules', 'left-pad-ish', 'package.json'), '{"name":"left-pad-ish","type":"module","exports":{"types":"./index.d.ts","default":"./index.js"}}');
writeFileSync(path.join(base, 'node_modules', 'left-pad-ish', 'index.d.ts'), 'export declare function pad(text: unknown, width: number): string;\n');

const project = new TypeScriptProject(base, resources);
const uri = pathToFileURL(path.join(base, 'workflow.spl')).href;
const CURSOR = '<|>';

/** Opens a workflow; `<|>` marks the cursor and is removed. */
function open(marked: string, target = uri): { context: WorkflowContext; position: Position; source: string } {
    const cursor = marked.indexOf(CURSOR);
    const source = cursor < 0 ? marked : marked.slice(0, cursor) + marked.slice(cursor + CURSOR.length);
    return { context: workflowContext(project, target, source), position: TextDocument.create(target, 'spl', 0, source).positionAt(Math.max(0, cursor)), source };
}
const at = (source: string, text: string, offset = 0): Position => {
    const index = source.indexOf(text);
    assert.ok(index >= 0, `'${text}' not found`);
    return TextDocument.create(uri, 'spl', 0, source).positionAt(index + offset);
};
/** The range of `part` inside the first occurrence of `text`. */
const span = (source: string, text: string, part = text): Range => {
    const start = at(source, text, text.indexOf(part));
    return { start, end: { line: start.line, character: start.character + part.length } };
};
const labels = (marked: string): string[] => {
    const { context, position } = open(marked);
    return completions(context, position).map(item => item.label);
};
const hoverText = (marked: string): string => {
    const { context, position } = open(marked);
    const result = hover(context, position);
    return result && typeof result.contents === 'object' && 'value' in result.contents ? result.contents.value : '';
};
/** Source, line, start and end character, and the first sentence of the message. */
const brief = (items: Diagnostic[]): unknown[] => items.map(({ source, range, message }) =>
    [source, range.start.line, range.start.character, range.end.character, message.split(/\.(?:\s|$)/)[0]]);
const lines = (...text: string[]): string => text.join('\n');

const TYPES = ['Str', 'Int', 'Float', 'Bool', 'Char', 'Nil', 'Any', 'Dict', 'Fn', 'List', 'Union', 'Nullable', 'Enum', 'Struct', 'Typedef', 'JsonSchema'];

test('the catalog, the ambient declarations and library() name the same 3.0 library', () => {
    const names = Object.keys(library()).sort();
    assert.deepEqual(Object.keys(catalog).sort(), names);
    const globals = readFileSync(path.join(resources.spl, 'globals.d.ts'), 'utf8');
    const declared = [...globals.matchAll(/^    const ([A-Za-z_$][\w$]*):/gm)].map(match => match[1]).filter(name => !name.startsWith('__')).sort();
    assert.deepEqual(declared, names);
    for (const name of [...TYPES, 't', 'readFile', 'writeFile', 'webFetch', 'webSearch', 'shell', 'env', 'args']) assert.ok(Object.hasOwn(catalog, name), name);
    assert.deepEqual(names.filter(name => /^[A-Z]/.test(name) && name !== 'Failure'), [...TYPES].sort(), 'types start with an uppercase letter');
    for (const name of ['think', 'go', 'str', 'int', 'object', 'enumOf', 'struct']) assert.ok(!Object.hasOwn(catalog, name), name);
    assert.doesNotMatch(JSON.stringify(catalog), /\b[a-z]+_[a-z]+\(|read_file|write_file|web_fetch|web_search|get_env|\bt\.[a-z]/,
        'tools are camelCase and types uppercase in the help texts');
});

test('every example type-checks without diagnostics', () => {
    const files = readdirSync(examples, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.spl')).sort();
    assert.ok(files.length > 20, `examples found in ${examples}`);
    const exampleProject = new TypeScriptProject(examples, resources);
    for (const file of files) {
        const context = workflowContext(exampleProject, pathToFileURL(path.join(examples, file)).href, readFileSync(path.join(examples, file), 'utf8'));
        assert.deepEqual(brief(diagnostics(context)), [], file);
        assert.ok(documentSymbols(context).every(symbol => !symbol.name.startsWith('__')), file);
    }
    const readme = /```spl\n([\s\S]*?)```/.exec(readFileSync(path.resolve(__dirname, '..', '..', 'README.md'), 'utf8').replaceAll('\r\n', '\n'));
    assert.deepEqual(brief(diagnostics(open(readme?.[1] ?? 'missing').context)), [], 'the example in README.md');
});

test('code completes the library, JavaScript globals, declarations and typed members', () => {
    const names = labels(lines('const notes = "raw";', 'function shout(text: string) { return text.toUpperCase(); }', '<|>'));
    for (const name of ['ask', 'agent', 'restrict', 'Struct', 'markdown', 'notes', 'shout', 'console', 'Promise', 'process', 'JSON']) assert.ok(names.includes(name), name);
    assert.ok(!names.includes('document'), 'browser globals are not offered');
    assert.ok(labels('const title = await ask("Title?");\ntitle.<|>').includes('toUpperCase'));
    const card = "const Card = Struct('Card', { term: Str, score: Int });\n";
    const members = labels(`${card}const card = await ask('Card', { schema: Card });\ncard.<|>`);
    assert.ok(members.includes('term') && members.includes('score'));
    assert.ok(labels(`${card}Card.<|>`).includes('coerce'));
    assert.ok(labels("import fs from 'node:fs';\nfs.<|>").includes('readFileSync'));
    assert.ok(labels("import { twice } from './helpers.ts';\nimport { pad } from 'left-pad-ish';\npad(twice(1), 2).<|>").includes('padStart'));
    assert.ok(labels("import { half } from './legacy.js';\nhalf(1).<|>").includes('toFixed'), 'imported JavaScript is typed by inference');
    assert.ok(labels("await ask('x', { fmt: '<|>' })").includes('integer'));
    assert.deepEqual(labels(lines('//*', '# Title <|>', '*//')), [], 'Markdown comments are prose');
    assert.ok(!labels(lines('const text = `', '---', '<|>', '---', '`;')).includes('mode'), 'a fence inside a template literal does not start a block');
});

test('completion details, hovers and signature help come from the library documentation', () => {
    const { context, position } = open('restr<|>');
    const item = completions(context, position).find(candidate => candidate.label === 'restrict');
    assert.ok(item);
    assert.equal(item.kind, CompletionItemKind.Constant);
    const resolved = resolveCompletion(context, item);
    assert.match(String(resolved.detail), /restrict/);
    assert.match(JSON.stringify(resolved.documentation), /Limits/);

    assert.match(hoverText('await as<|>k("x");'), /const ask[\s\S]*Asks the model for a value/);
    assert.match(hoverText('const total = 1 + 1;\nto<|>tal;'), /const total: number/);
    assert.equal(hoverText(lines('//*', 'Prose with a<|>sk in it.', '*//')), '');

    const help = open("await writeFile('./out.txt', <|>)");
    const signature = signatureHelp(help.context, help.position);
    assert.ok(signature);
    assert.match(signature.signatures[0].label, /writeFile\(path: string, content: string\)/);
    assert.equal(signature.activeParameter, 1);
});

test('TypeScript diagnostics in code keep their positions', () => {
    const { context, source } = open(lines(
        '//*', '# Title', '*//', '',
        "const count: number = 'three';",
        'function wait() { await ask("x"); }',
        'const maybe: string | undefined = env.NAME;',
        'maybe.length;',
    ));
    const found = diagnostics(context);
    assert.deepEqual(found.map(item => [item.code, item.range]), [
        [2322, span(source, 'count: number', 'count')],
        [1308, span(source, 'await ask', 'await')],
        [18048, span(source, 'maybe.length', 'maybe')],
    ]);
    assert.ok(found.every(item => item.source === 'ts' && item.severity === DiagnosticSeverity.Error));
    const broken = open(lines('---', 'model: m', '---', '', 'const a = ;'));
    assert.deepEqual(brief(diagnostics(broken.context)), [['ts', 4, 10, 11, 'Expression expected']]);
    assert.deepEqual(diagnostics(open('const fine: number = 1;\nlog(fine);').context), []);
});

test('TypeScript diagnostics inside blocks map back through the spans of the scanner', () => {
    const { context, source } = open(lines(
        'const notes = "raw";', '',
        '---', 'outputVar: summary', 'outputType: Sumary', '', 'Summarize @notes for @reader and @notes.size', '---', '',
        '---', 'mode: agent', '', 'Count the words of @note ->[Lisst(Int)] @counts', 'and tag them ->[List(Str, Int)] @tags', '---', '',
        '---', 'mode: codegen', '', 'Slug -> @slugify(text: Strng): string', '---',
    ));
    assert.deepEqual(brief(diagnostics(context)), [
        ['ts', ...where(source, 'outputType: Sumary', 'Sumary'), "Cannot find name 'Sumary'"],
        ['ts', ...where(source, '@reader', 'reader'), "Cannot find name 'reader'"],
        ['ts', ...where(source, '@notes.size', 'size'), "Property 'size' does not exist on type '\"raw\"'"],
        ['ts', ...where(source, '@note ', 'note'), "Cannot find name 'note'"],
        ['ts', ...where(source, 'Lisst(Int)', 'Lisst'), "Cannot find name 'Lisst'"],
        ['ts', ...where(source, 'List(Str, Int)', 'Int'), 'Expected 1 arguments, but got 2'],
        ['ts', ...where(source, 'text: Strng', 'Strng'), "Cannot find name 'Strng'"],
    ]);
    assert.deepEqual(diagnostics(open(source.replaceAll('\n', '\r\n')).context), diagnostics(open(source).context), 'line endings do not move positions');
});

test('diagnostics in generated code without a span are reported on the source line, outputs at their names', () => {
    const { context, source } = open(lines(
        'const notes = "raw";',
        'const fixed = 1;',
        'function later() {',
        '    ---',
        '    mode: agent',
        '',
        '    Summarize @notes -> @notes and count -> @=fixed',
        '    ---',
        '}',
    ));
    const found = brief(diagnostics(context));
    assert.deepEqual(found, [
        ['ts', 3, 4, 7, "'await' expressions are only allowed within async functions and at the top levels of modules"],
        ['ts', ...where(source, '-> @=fixed', 'fixed'), "Cannot assign to 'fixed' because it is a constant"],
    ]);
    const clash = open(lines('const answer = 1;', '', '---', 'outputVar: answer', '', 'Say something', '---'));
    assert.deepEqual(brief(diagnostics(clash.context)), [
        ['ts', 0, 6, 12, "Cannot redeclare block-scoped variable 'answer'"],
        ['ts', ...where(clash.source, 'outputVar: answer', 'answer'), "Cannot redeclare block-scoped variable 'answer'"],
    ]);
});

test('scanner problems are errors at their ranges and replace what TypeScript says about the same line', () => {
    const { context, source } = open(lines(
        'enum Color { Red }', '',
        '---', 'modle: gpt', 'outputVar: x', '', 'Go', '---', '',
        '---', 'Say hi', '---', '',
        '---', 'mode: agent', 'outputVar: y', '', 'Go on', '---', '',
        '{js}', '',
        '---', 'never closed',
    ));
    const found = diagnostics(context);
    assert.deepEqual(brief(found).map(item => (item as unknown[]).slice(0, 4)), [
        ['spl', ...where(source, 'enum Color', 'enum')],
        ['spl', ...where(source, 'modle: gpt', 'modle')],
        ['spl', 9, 0, 3],
        ['spl', ...where(source, 'outputVar: y', 'outputVar')],
        ['spl', 20, 0, 4],
        ['spl', 22, 0, 3],
    ]);
    assert.ok(found.every(item => item.severity === DiagnosticSeverity.Error));
    assert.match(found[0].message, /use a union of string literals instead of enum/);
    assert.match(found[1].message, /did you mean `model`\?/);
    assert.match(found[2].message, /ask block needs outputVar/);
    assert.match(found[3].message, /applies only to ask blocks/);
    assert.match(found[4].message, /SPL 2\.x syntax/);
    assert.match(found[5].message, /Unmatched block opened at line 23/);
});

/** Line, start and end character of `part` inside `text`. */
function where(source: string, text: string, part = text): [number, number, number] {
    const { start, end } = span(source, text, part);
    return [start.line, start.character, end.character];
}

const SCOPE = lines(
    '---', 'model: gpt-6-luna', '---', '',
    "import { twice } from './helpers.ts';",
    "const Joke = Struct('Joke', { setup: Str, punchline: Str });",
    'const notes = "raw";',
    'let count = 0;',
    'function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }',
    '',
    '---', 'mode: agent', '', 'Call @fib with 10 ->[Int] @fib10', '---', '',
);

test('@ in a block completes the names in scope at that point and the library', () => {
    const { context, position } = open(`${SCOPE}---\noutputVar: joke\n\nA joke about @<|>\n---\n\nconst below = 1;\nfunction hoisted() {}\n`);
    const items = completions(context, position);
    const names = items.map(item => item.label);
    for (const name of ['twice', 'Joke', 'notes', 'count', 'fib', 'fib10', 'hoisted', 'env', 'args', 'readFile', 'Str']) assert.ok(names.includes(name), name);
    for (const name of ['below', 'joke', 'console', 'Promise', '__spl', '__workflow']) assert.ok(!names.includes(name), name);
    const item = (name: string) => items.find(candidate => candidate.label === name)!;
    assert.deepEqual([item('fib').kind, item('fib').detail], [CompletionItemKind.Function, '(n: number) => number']);
    assert.deepEqual([item('fib10').kind, item('fib10').detail], [CompletionItemKind.Variable, 'number']);
    assert.equal(item('Joke').kind, CompletionItemKind.Struct);
    assert.deepEqual([item('env').detail, item('env').documentation], [catalog.env.signature, catalog.env.description]);
    assert.ok(item('notes').sortText! < item('env').sortText!, 'names of the workflow come first');
    assert.deepEqual(item('notes').textEdit, { range: { start: position, end: position }, newText: 'notes' });

    const typed = open(`${SCOPE}---\nmode: agent\n\nUse @no<|>te and more\n---\n`);
    const edit = completions(typed.context, typed.position).find(candidate => candidate.label === 'notes')!.textEdit;
    assert.deepEqual(edit, { range: span(typed.source, '@note ', 'note'), newText: 'notes' });
});

test('@ completion follows the syntax of references and outputs', () => {
    const block = (text: string, mode = 'agent'): string[] => labels(`${SCOPE}---\nmode: ${mode}\n\n${text}\n---\n`);
    assert.deepEqual(block('Read @env.<|>'), [], 'environment variables are not known');
    assert.deepEqual(block('Mail user@<|>'), [], 'an @ inside a word is text');
    assert.deepEqual(block('A literal @@<|>'), []);
    assert.deepEqual(block('Count the lines -> @<|>'), [], 'an output names a new variable');
    assert.deepEqual(block('Count the lines ->[Int] @<|>'), []);
    assert.deepEqual(block('Count the lines ->[Int] @=<|>'), ['count'], '@= assigns a variable that can change');
    assert.ok(block('Summarize @notes and @<|> -> @summary').includes('notes'));
    assert.deepEqual(block('Plain text <|>'), []);
    assert.deepEqual(block('---\n<|>'.slice(4)).filter(name => name === 'fib'), [], 'only header keys start a line');

    const nested = labels(lines('const outer = 1;', 'async function work(item: string) {', '    const local = 2;', '    ---', '    mode: agent', '',
        '    Use @<|>', '    ---', '    const after = 3;', '}', 'const afterwards = 4;'));
    for (const name of ['outer', 'item', 'local', 'work', 'afterwards']) assert.ok(nested.includes(name), name);
    assert.ok(!nested.includes('after'), 'a constant below the block in the same function has no value yet');
});

test('hover on @name shows the value, on an output its variable, on a type expression the type', () => {
    const body = `${SCOPE}---\noutputVar: joke\noutputType: Joke\n\nA joke about @notes and @fib10, using @notes.length\n---\n\nlog(joke);\n`;
    const cursor = (text: string, offset: number) => body.replace(text, text.slice(0, offset) + CURSOR + text.slice(offset));
    assert.match(hoverText(cursor('@notes and', 3)), /const notes: "raw"/);
    assert.match(hoverText(cursor('@fib10, using', 1)), /const fib10: number/);
    assert.match(hoverText(cursor('@notes.length', 9)), /\(property\) String\.length: number/);
    assert.match(hoverText(cursor('@fib with', 2)), /function fib\(n: number\): number/);
    assert.match(hoverText(cursor('@fib10\n', 3)), /const fib10: number/);
    assert.match(hoverText(cursor('outputVar: joke', 13)), /const joke: \{\s*setup: string;\s*punchline: string;\s*\}/);
    assert.match(hoverText(cursor('outputType: Joke', 14)), /const Joke: /);
    assert.match(hoverText(cursor('->[Int]', 4)), /const Int: /);
    assert.equal(hoverText(cursor('A joke about', 4)), '', 'instruction text is prose');

    const { context, position, source } = open(cursor('@notes and', 3));
    assert.deepEqual(hover(context, position)?.range, span(source, '@notes and', 'notes'));
    const output = open(cursor('@fib10\n', 3));
    assert.deepEqual(hover(output.context, output.position)?.range, span(output.source, '@fib10\n', 'fib10'));

    const assigned = `let total = 0;\n\n---\nmode: agent\n\nAdd them up ->[Int] @=to${CURSOR}tal\n---\n`;
    assert.match(hoverText(assigned), /let total: number/);
    const generated = `---\nmode: codegen\n\nSlug -> @slu${CURSOR}gify(text: string): string\n---\n`;
    assert.match(hoverText(generated), /const slugify: \(text: string\) => string/);
    assert.match(hoverText(generated.replace(CURSOR, '').replace('text: str', `te${CURSOR}xt: str`)), /text: string/);
    assert.match(hoverText(`---\nmode: codegen\n\nPad a string -> @pa${CURSOR}d\n---\n`), /const pad: \(\.\.\.args: any\[\]\) => any/, 'the default signature is not in the source');
});

test('header keys complete for the mode of the block, with their values and types', () => {
    const header = (text: string): string[] => labels(`${SCOPE}---\n${text}\n---\n`);
    const names = (mode: string) => HEADER_KEYS.filter(key => key.applies === 'all' || key.applies === mode).map(key => key.name);
    assert.deepEqual(header('<|>'), names('ask'), 'ask is the default mode');
    assert.deepEqual(header('mode: agent\n<|>'), names('agent').filter(name => name !== 'mode'));
    assert.deepEqual(header('mode: codegen\nmodel: m\nto<|>\n\nSlug -> @slug()'), names('codegen').filter(name => name !== 'mode' && name !== 'model'));
    assert.ok(header('mode: agent\n<|>').includes('restrict') && !header('mode: agent\n<|>').includes('outputVar'));
    assert.deepEqual(header('mode: <|>'), ['ask', 'agent', 'codegen']);
    assert.deepEqual(header('mode: ag<|>\n\nGo -> @x'), ['ask', 'agent', 'codegen']);
    assert.deepEqual(header('outputVar: x\nreasoning: <|>\n\nGo'), ['none', 'low', 'medium', 'high', 'max']);
    assert.deepEqual(header('outputVar: x\nhide: <|>\n\nGo'), ['true', 'false']);
    assert.deepEqual(header('model: <|>'), [], 'models are free text');
    assert.deepEqual(header('enforce:\n  - <|>'), [], 'YAML values are free text');
    assert.deepEqual(header('outputVar: x\n\n<|>'), [], 'a blank line ends the header');
    assert.deepEqual(header('outputVar: x\n\nmo<|>'), []);
    assert.deepEqual(labels('---\nmo<|>'), names('ask'), 'a block that is still open has a header');

    const { context, position, source } = open(`---\nou<|>\n\nSay hi\n---\n`);
    const item = completions(context, position).find(candidate => candidate.label === 'outputType')!;
    assert.deepEqual(item.textEdit, { range: span(source, 'ou\n', 'ou'), newText: 'outputType: ' });
    assert.equal(item.kind, CompletionItemKind.Property);
    assert.match(JSON.stringify(item.documentation), /Type expression the answer is coerced to[\s\S]*Applies only to ask blocks/);
    assert.equal(item.command?.command, 'editor.action.triggerSuggest', 'the types are offered next');
    const renamed = open(`---\nou<|>tputVar: x\n\nSay hi\n---\n`);
    assert.deepEqual(completions(renamed.context, renamed.position).find(candidate => candidate.label === 'outputType')!.textEdit,
        { range: span(renamed.source, 'outputVar'), newText: 'outputType' });

    const types = header('outputVar: x\noutputType: <|>\n\nGo');
    for (const name of [...TYPES, 'Joke']) assert.ok(types.includes(name), name);
    for (const name of ['notes', 'fib', 'ask', 't', 'env', 'validate']) assert.ok(!types.includes(name), name);
    assert.deepEqual(header('outputVar: x\noutputType: List(Jo<|>)\n\nGo').filter(name => name === 'Joke'), ['Joke']);
    assert.deepEqual(header('mode: agent\n\nList the files ->[<|>').sort(), types.sort());
    assert.ok(header('mode: agent\n\nList the files ->[List(<|>)] @files').includes('Str'));
    assert.deepEqual(header('mode: agent\n\nList the files ->[Str.<|>'), [], 'members are not types');
    assert.deepEqual(header('mode: agent\n\nList the files [<|>'), [], 'only an arrow declares an output');
});

test('trigger characters complete only what they start', () => {
    const triggered = (marked: string, character: string): string[] => {
        const { context, position } = open(marked);
        return completions(context, position, { triggerKind: CompletionTriggerKind.TriggerCharacter, triggerCharacter: character }).map(item => item.label);
    };
    assert.deepEqual(triggered('---\n <|>\n---\n', ' '), [], 'indenting a line does not offer header keys');
    assert.deepEqual(triggered('---\nmode: <|>\n---\n', ' '), ['ask', 'agent', 'codegen']);
    assert.deepEqual(triggered(`${SCOPE}---\nmode: agent\n\nGo on. <|>\n---\n`, ' '), []);
    assert.ok(triggered(`${SCOPE}---\nmode: agent\n\nUse @<|>\n---\n`, '@').includes('notes'));
    assert.ok(triggered(`${SCOPE}---\nmode: agent\n\nList them ->[<|>\n---\n`, '[').includes('Joke'));
    assert.deepEqual(triggered(`${SCOPE}---\nmode: agent\n\nUse notes.<|>\n---\n`, '.'), []);
    assert.ok(triggered('const list = [1];\nlist.<|>', '.').includes('map'));
    assert.deepEqual(triggered('const list = [1];\nconst other = <|>', ' '), []);
    assert.deepEqual(triggered('const list = [<|>', '['), []);
});

test('hover explains header keys', () => {
    const text = hoverText(`---\noutputVar: x\nrea<|>soning: high\n\nGo\n---\n`);
    assert.match(text, /`reasoning: none \| low \| medium \| high \| max`/);
    assert.match(text, /Reasoning level/);
    assert.match(hoverText(`---\nmode: agent\nrest<|>rict: ./out\n\nGo\n---\n`), /Limits for this block[\s\S]*Applies only to agent blocks/);
    assert.equal(hoverText(`---\noutputVar: x\nreasoning: hi<|>gh\n\nGo\n---\n`), '', 'values are not explained');
    assert.match(hoverText(`---\nmod<|>el: gpt-6-luna\n---\n`), /Model id/);
});

test('imports of other .spl files resolve to their virtual modules, on disk and open', () => {
    const body = lines("import squares, { square } from './math.spl';", "import { twice } from './helpers.ts';", '',
        'const four: number = square(2);', "const all = await squares(['2', '3']);", 'log(twice(four), all);', '');
    const { context, source } = open(body);
    assert.deepEqual(diagnostics(context), []);
    const math = pathToFileURL(path.join(base, 'math.spl')).href;
    assert.deepEqual(definition(context, at(source, 'square(2)', 2)), [{ uri: math, range: { start: { line: 4, character: 16 }, end: { line: 4, character: 22 } } }]);
    assert.match(hoverText(body.replace('square(2)', `squ${CURSOR}are(2)`)), /square\(n: number\): number/);
    assert.match(hoverText(body.replace('await squares', `await squ${CURSOR}ares`)), /Workflow/);
    assert.match(hoverText(body.replace('const all', `const a${CURSOR}ll`)), /const all: unknown/);

    assert.match(String(diagnostics(open(body.replace('./math.spl', './missing.spl')).context).map(item => item.message)), /^Cannot find module '\.\/missing\.spl'/);

    // The editor's text of an imported workflow wins over the file on disk, and its uses are found across files.
    const edited = open(lines('export function cube(n: number): number {', '    return n * n * n;', '}', ''), math);
    assert.match(brief(diagnostics(open(body).context)).join(), /has no exported member 'square'/);
    const fixed = open(body.replaceAll('square(', 'cube(').replace('{ square }', '{ cube }'));
    assert.deepEqual(diagnostics(fixed.context), []);
    assert.deepEqual(references(edited.context, at(edited.source, 'cube')).map(item => [item.uri, item.range.start.line]),
        [[math, 0], [uri, 0], [uri, 3]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    assert.deepEqual(Object.keys(rename(edited.context, at(edited.source, 'cube'), 'third')?.changes ?? {}).sort(), [math, uri].sort());
    project.close(math);
    assert.deepEqual(diagnostics(open(body).context), [], 'a closed document is read from disk again');
});

test('definitions, references, rename and symbols connect code, @names and outputs', () => {
    const body = lines(
        'const notes = "raw";',
        'function inner() { const notes = 1; return notes; }',
        '',
        '---', 'mode: agent', '', 'Summarize @notes -> @summary', 'and count the words ->[Int] @words', '---', '',
        '---', 'outputVar: title', '', 'A title for @summary', '---', '',
        'log(notes, summary, words, title);',
        '',
    );
    const { context, source } = open(body);
    assert.deepEqual(diagnostics(context), []);
    const declaration = { uri, range: span(source, 'notes') };
    assert.deepEqual(definition(context, at(source, '@notes', 3)), [declaration]);
    assert.deepEqual(definition(context, at(source, 'log(notes', 5)), [declaration]);
    assert.deepEqual(definition(context, at(source, 'summary, words', 2)), [{ uri, range: span(source, '-> @summary', 'summary') }]);
    assert.deepEqual(definition(context, at(source, 'title);', 2)), [{ uri, range: span(source, 'outputVar: title', 'title') }]);
    assert.deepEqual(definition(context, at(source, '@summary\n---', 3)), [{ uri, range: span(source, '-> @summary', 'summary') }]);

    assert.deepEqual(references(context, at(source, 'log(notes', 5)).map(item => item.range),
        [span(source, 'notes'), span(source, '@notes', 'notes'), span(source, 'log(notes', 'notes')]);
    assert.equal(references(context, at(source, 'const notes = 1', 7)).length, 2, 'a local of the same name is another variable');
    const uses = [span(source, '-> @summary', 'summary'), span(source, 'for @summary', 'summary'), span(source, 'log(notes, summary', 'summary')];
    assert.deepEqual(references(context, at(source, '-> @summary', 5)).map(item => item.range), uses);
    assert.deepEqual(documentHighlights(context, at(source, 'for @summary', 6)).map(item => [item.range, item.kind]), [[uses[0], 3], [uses[1], 2], [uses[2], 2]]);

    assert.deepEqual(prepareRename(context, at(source, 'for @summary', 6)), { range: uses[1], placeholder: 'summary' });
    assert.deepEqual(rename(context, at(source, 'for @summary', 6), 'digest'), { changes: { [uri]: uses.map(range => ({ range, newText: 'digest' })) } });
    assert.equal(rename(context, at(source, 'notes'), 'draft')?.changes?.[uri].length, 3);
    assert.equal(rename(context, at(source, 'title);', 1), 'heading')?.changes?.[uri].length, 2);
    assert.equal(rename(context, at(source, 'notes'), 'not a name'), null);
    assert.equal(prepareRename(context, at(source, 'log(notes')), null, 'library names cannot be renamed');
    assert.equal(prepareRename(context, at(source, 'Summarize', 2)), null, 'instruction text is not a name');

    assert.deepEqual(documentSymbols(context).map(item => [item.name, item.kind, item.selectionRange.start.line]).sort(), [
        ['inner', SymbolKind.Function, 1], ['notes', SymbolKind.Constant, 0], ['summary', SymbolKind.Constant, 6],
        ['title', SymbolKind.Constant, 11], ['words', SymbolKind.Constant, 7],
    ]);
    assert.deepEqual(foldingRanges(open(lines('//*', '# Title', '*//', '', body, 'function long() {', '    return 1;', '}', '')).context)
        .map(item => [item.startLine, item.endLine, item.kind]).sort((a, b) => Number(a[0]) - Number(b[0])),
    [[0, 2, 'comment'], [7, 12, undefined], [14, 18, undefined], [22, 24, undefined]]);

    const short = open(lines('---', 'outputVar: a', '', 'Say hi', '---', 'log(a);'));
    assert.deepEqual(references(short.context, { line: 5, character: 4 }).map(item => [item.range.start, item.range.end]), [
        [{ line: 1, character: 11 }, { line: 1, character: 12 }], [{ line: 5, character: 4 }, { line: 5, character: 5 }],
    ], 'an output is found after its key, not inside it');
    assert.match(JSON.stringify(hover(short.context, { line: 1, character: 11 })), /const a: string/);
    assert.equal(hover(short.context, { line: 1, character: 7 })?.range?.start.character, 0, 'the key is explained as a key');
});

test('eval files (*.eval.spl) type-check eval blocks and judge assertions', () => {
    const evalUri = pathToFileURL(path.join(base, 'suite.eval.spl')).href;
    const evalSource = lines(
        "eval 'Color check' {",
        "  let answer = ask('Color blue in hex notation')",
        '',
        '  ---',
        '',
        "  judge.faithful(answer, 'color is blue', 0.99)",
        "  judge.toolUse('webFetch', 'https://www.google.com')",
        '}',
        '',
    );
    const { context } = open(evalSource, evalUri);
    assert.deepEqual(diagnostics(context), []);
    const { context: compContext, position } = open(evalSource.replace('judge.faithful', 'judge.fa<|>ithful'), evalUri);
    assert.ok(completions(compContext, position).some(item => item.label === 'faithful'));
    project.close(evalUri);
});

test('the server speaks LSP end to end', { timeout: 60_000 }, async t => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'server.cjs'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const connection = createProtocolConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    t.after(() => { connection.dispose(); child.kill(); });
    connection.listen();
    const published: PublishDiagnosticsParams[] = [];
    let notify: (() => void) | undefined;
    connection.onNotification(PublishDiagnosticsNotification.type, params => { published.push(params); notify?.(); });
    const nextDiagnostics = async (document: string, version: number): Promise<PublishDiagnosticsParams> => {
        for (;;) {
            const found = published.find(item => item.uri === document && item.version === version);
            if (found) return found;
            await new Promise<void>(resolve => { notify = resolve; });
        }
    };
    const initialized = await connection.sendRequest(InitializeRequest.type, {
        processId: process.pid, rootUri: pathToFileURL(base).href, capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(base).href, name: 'workspace' }],
    });
    assert.ok(initialized.capabilities.completionProvider?.resolveProvider);
    assert.ok(initialized.capabilities.completionProvider?.triggerCharacters?.includes('@'));
    assert.ok(initialized.capabilities.renameProvider && initialized.capabilities.foldingRangeProvider);
    await connection.sendNotification(InitializedNotification.type, {});

    const flow = pathToFileURL(path.join(base, 'flows', 'flow.spl')).href;
    const first = lines("import { square } from '../math.spl';", 'const value = square(2);', '', '---', 'mode: agent', '',     'Double @valu -> @doubled', '---', '', 'const a = ;', '');
    await connection.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri: flow, languageId: 'spl', version: 1, text: first } });
    assert.deepEqual((await nextDiagnostics(flow, 1)).diagnostics.map(item => [item.source, item.range.start.line, item.range.start.character, item.message.split('.')[0]]), [
            ['ts', 9, 10, 'Expression expected'], ['ts', 6, 8, "Cannot find name 'valu'"],
    ]);

    const text = lines("import { square } from '../math.spl';", 'const value = square(2);', 'value.', 'toFixed;', "await writeFile('a', )", '',
        '---', 'mode: agent', '', 'Double @value and @ -> @doubled', '---', '', 'log(doubled);', '');
    await connection.sendNotification(DidChangeTextDocumentNotification.type, { textDocument: { uri: flow, version: 2 }, contentChanges: [{ text }] });
    assert.deepEqual((await nextDiagnostics(flow, 2)).diagnostics.map(item => item.message), ['Expected 2 arguments, but got 1.']);
    const position = (needle: string, offset = 0) => TextDocument.create(flow, 'spl', 2, text).positionAt(text.indexOf(needle) + offset);

    const members = await connection.sendRequest(CompletionRequest.type, {
        textDocument: { uri: flow }, position: position('value.\n', 6),
        context: { triggerKind: CompletionTriggerKind.TriggerCharacter, triggerCharacter: '.' },
    });
    const items = Array.isArray(members) ? members : members?.items ?? [];
    const toFixed = items.find(item => item.label === 'toFixed');
    assert.ok(toFixed, 'the imported workflow is typed');
    assert.match(String((await connection.sendRequest(CompletionResolveRequest.type, toFixed)).detail), /toFixed/);
    const ignored = await connection.sendRequest(CompletionRequest.type, {
        textDocument: { uri: flow }, position: position("'a', )", 5),
        context: { triggerKind: CompletionTriggerKind.TriggerCharacter, triggerCharacter: '[' },
    });
    assert.deepEqual(ignored, []);
    const shared = await connection.sendRequest(CompletionRequest.type, {
        textDocument: { uri: flow }, position: position('and @', 5),
        context: { triggerKind: CompletionTriggerKind.TriggerCharacter, triggerCharacter: '@' },
    });
    const sharedLabels = (Array.isArray(shared) ? shared : shared?.items ?? []).map(item => item.label);
    assert.ok(sharedLabels.includes('value') && sharedLabels.includes('square') && sharedLabels.includes('args'));

    const info = await connection.sendRequest(HoverRequest.type, { textDocument: { uri: flow }, position: position('@value', 2) });
    assert.match(JSON.stringify(info?.contents), /const value: number/);
    const help = await connection.sendRequest(SignatureHelpRequest.type, { textDocument: { uri: flow }, position: position("'a', )", 5) });
    assert.equal(help?.activeParameter, 1);
    const target = await connection.sendRequest(DefinitionRequest.type, { textDocument: { uri: flow }, position: position('log(doubled', 6) });
    assert.deepEqual(target, [{ uri: flow, range: { start: position('@doubled', 1), end: position('@doubled', 8) } }]);
    const symbols = await connection.sendRequest(DocumentSymbolRequest.type, { textDocument: { uri: flow } });
    assert.deepEqual(symbols?.map(item => item.name).sort(), ['doubled', 'value']);
    const folds = await connection.sendRequest(FoldingRangeRequest.type, { textDocument: { uri: flow } });
    assert.deepEqual(folds?.map(item => [item.startLine, item.endLine]), [[6, 10]]);
    const edit = await connection.sendRequest(RenameRequest.type, { textDocument: { uri: flow }, position: position('value = '), newName: 'result' });
    assert.equal(edit?.changes?.[flow].length, 3);

    // A change in an imported workflow shows in the open documents that import it.
    const math = pathToFileURL(path.join(base, 'math.spl')).href;
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: math, languageId: 'spl', version: 1, text: 'export function cube(n: number): number { return n ** 3; }\n' },
    });
    await nextDiagnostics(math, 1);
    const stale = published.findLast(item => item.uri === flow)!;
    assert.match(stale.diagnostics.map(item => item.message).join(), /has no exported member 'square'/);
});
