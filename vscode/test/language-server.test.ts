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

    await connection.sendRequest(ShutdownRequest.type);
    await connection.sendNotification(ExitNotification.type);
});
