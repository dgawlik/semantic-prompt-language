import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { test } from 'node:test';
import {
    createProtocolConnection, IPCMessageReader, IPCMessageWriter, StreamMessageReader, StreamMessageWriter,
    CompletionRequest, DefinitionRequest, DocumentSymbolRequest, ExitNotification, HoverRequest,
    InitializeRequest, InitializedNotification, ShutdownRequest, ReferencesRequest, RenameRequest,
    PrepareRenameRequest, DocumentHighlightRequest, SignatureHelpRequest, FoldingRangeRequest,
    SemanticTokensRequest, WorkspaceSymbolRequest, ResponseError,
    DidChangeTextDocumentNotification, DidCloseTextDocumentNotification, DidOpenTextDocumentNotification,
    PublishDiagnosticsNotification, CompletionItemKind, SymbolKind, TextDocumentSyncKind,
    type PublishDiagnosticsParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze, completions, definition, documentSymbols, hover } from '../src/features';
import {
    documentHighlights, foldingRanges, prepareRename, references, rename,
    semanticTokenLegend, semanticTokens, signatureHelp, workspaceSymbols,
} from '../src/languageFeatures';
import { builtins } from '../src/catalog';
import { makeBuiltins } from '../../lang/src/builtins.js';
import { ASK_MODIFIER_NAMES, MODIFIER_NAMES } from '../../lang/src/parser.js';

const root = path.resolve(__dirname, '..', '..');
const uri = 'file:///test.spl';
const document = (source: string) => TextDocument.create(uri, 'spl', 1, source);
const analysis = (source: string) => analyze(document(source));
const markdownSource = (body: string) => `---\nextension: semantic-prompt-language\nversion: 1\n---\n\n${body}`;
const markdownAnalysis = (source: string) => analyze(TextDocument.create('file:///workflow.md', 'markdown', 1, source));
const after = (source: string, text: string, occurrence = 0) => {
    const position = at(source, text, occurrence);
    position.character += text.length;
    return position;
};

test('local module imports provide bindings, completions and typed diagnostics without execution', t => {
    const directory = mkdtempSync(path.join(tmpdir(), 'spl-editor-imports-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(path.join(directory, 'helpers.spl'), `def add(value: int) -> int:
    return value + 1`);
    const uri = pathToFileURL(path.join(directory, 'main.md')).href;
    const source = markdownSource("```spl\nimport { add as increment } from './helpers.spl'\nimport * as helpers from './helpers.spl'\nsuccess increment(2)\n```");
    const result = analyze(TextDocument.create(uri, 'markdown', 1, source));
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.bindings.some(binding => binding.name === 'increment'));
    assert.ok(result.bindings.some(binding => binding.name === 'helpers'));
    assert.ok(completions(result, at(source, 'success')).some(item => item.label === 'increment'));
    const partial = source.replace('success increment(2)', 'helpers.');
    const member = analyze(TextDocument.create(uri, 'markdown', 2, partial));
    assert.ok(completions(member, member.document.positionAt(partial.lastIndexOf('helpers.') + 'helpers.'.length))
        .some(item => item.label === 'add'));
    const cell = analyze(TextDocument.create(uri.replace(/^file:/, 'vscode-notebook-cell:'), 'markdown', 1, source));
    assert.deepEqual(cell.diagnostics, []);
    const invalid = source.replace('increment(2)', "helpers.add('wrong')");
    assert.match(analyze(TextDocument.create(uri, 'markdown', 2, invalid)).diagnostics[0].message, /expected int/);
    writeFileSync(path.join(directory, 'helpers.spl'), "let count: int = 'wrong'");
    const external = analyze(TextDocument.create(uri, 'markdown', 3,
        markdownSource("```spl\nimport * as helpers from './helpers.spl'\n```"))).diagnostics[0];
    assert.match(external.message, /helpers\.spl:1:.*expected int/);
    assert.equal(external.range.start.line, 6);
});

test('bundled Markdown standard library imports work in SPL and fenced Markdown', () => {
    const source = "import { Document } from 'markdown'\nimport * as markdown from 'markdown'\nlet doc = Document().heading('Report', 1)\nsuccess doc.to_string()";
    const uri = pathToFileURL(path.join(root, 'markdown-library.spl')).href;
    const inspect = (text: string) => analyze(TextDocument.create(uri, 'spl', 1, text));
    assert.deepEqual(inspect(source).diagnostics, []);
    assert.deepEqual(analyze(TextDocument.create(uri.replace(/\.spl$/, '.md'), 'markdown', 1,
        markdownSource('```spl\n' + source + '\n```'))).diagnostics, []);
    const partial = source + '\nmarkdown.';
    const member = inspect(partial);
    assert.ok(completions(member, member.document.positionAt(partial.length)).some(item => item.label === 'Document'));
    assert.match(inspect(source.replace("heading('Report', 1)", "heading('Report', 'one')")).diagnostics[0].message, /expected int/);
});

test('Markdown keeps ordinary documents quiet and gates features on frontmatter', () => {
    const plain = markdownAnalysis('# Ordinary Markdown\n\n> @success\n\n```spl\ninvalid !\n```');
    assert.deepEqual(plain.diagnostics, []);
    assert.deepEqual(documentSymbols(plain), []);
    assert.deepEqual(completions(plain, { line: 2, character: 5 }), []);
    const wrongVersion = markdownSource('Text').replace('version: 1', 'version: 2');
    assert.match(markdownAnalysis(wrongVersion).diagnostics[0].message, /version: 1/);
});

test('Markdown preserves positions and shared symbols across code and natural language', () => {
    const source = markdownSource('```spl\nlet count = 1\n```\n\n> Increment @count.\n\nComment\n\n```spl\nsuccess count\n```');
    const result = markdownAnalysis(source);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(documentSymbols(result)[0].selectionRange.start.line, 6);
    const reference = at(source, '@count');
    reference.character++;
    assert.equal(definition(result, reference)?.range.start.line, 6);
    assert.match(JSON.stringify(hover(result, reference)), /let count/);
    assert.ok(completions(result, reference).some(item => item.label === 'count'));
    assert.deepEqual(completions(result, at(source, 'Comment')), []);
    const error = markdownAnalysis(markdownSource('Comment\n\n```spl\nask(unknown=1) \'x\'\n```'));
    assert.equal(error.diagnostics[0].range.start.line, 8);
    assert.match(error.diagnostics[0].message, /unknown modifier/);
});

test('Markdown validates each fence independently', () => {
    const result = markdownAnalysis(markdownSource('```spl\nif True:\n```\n\n```spl\n    pass\n```'));
    assert.match(result.diagnostics[0].message, /indented block/);
});

test('Markdown validates grouped blockquote controls before execution', () => {
    const valid = markdownAnalysis(markdownSource('> @CTL(restrict={fs: ["./src"]}, model="other", reasoning="high") Review files.'));
    assert.deepEqual(valid.diagnostics, []);
    const invalid = markdownAnalysis(markdownSource('> @CTL(\n> reasoning="invalid") Act.'));
    assert.equal(invalid.diagnostics[0].range.start.line, 6);
    assert.match(invalid.diagnostics[0].message, /reasoning must be/);
    assert.match(markdownAnalysis(markdownSource('> @Human Approve?')).diagnostics[0].message, /removed/);
});

test('blockquote completion offers CTL and references instead of SPL statement keywords', () => {
    const source = markdownSource('```spl\nlet notes = "draft"\ndef review():\n    pass\n```\n\n> @');
    const result = markdownAnalysis(source);
    const items = completions(result, result.document.positionAt(source.length));
    for (const name of ['CTL', 'CODEGEN', 'notes', 'review', 'validate', 'success', 'fail']) {
        assert.ok(items.some(item => item.label === name), name);
    }
    for (const name of ['let', 'if', 'restrict', 'enforce', 'forbid', 'human']) {
        assert.ok(!items.some(item => item.label === name), name);
    }
    assert.equal(items.find(item => item.label === 'CTL')?.textEdit?.newText, 'CTL($0)');
    assert.equal(items.find(item => item.label === 'CODEGEN')?.textEdit?.newText, "CODEGEN '${1:Function description}'$0");
    const existing = markdownSource('> @CTL()');
    const existingAnalysis = markdownAnalysis(existing);
    const marker = completions(existingAnalysis, after(existing, '@CT')).find(item => item.label === 'CTL');
    assert.ok(marker?.textEdit && 'range' in marker.textEdit);
    assert.equal(TextDocument.applyEdits(existingAnalysis.document, [marker.textEdit]), existing);
    const prose = markdownSource('> Write a review');
    assert.deepEqual(completions(markdownAnalysis(prose), TextDocument.create('', 'markdown', 1, prose).positionAt(prose.length)), []);
});

test('CODEGEN descriptions are literal strings, not variable references or inferred outputs', () => {
    const source = markdownSource("> @CTL(reasoning='high')\n> @CODEGEN '''Define answer() using @notes, save to @hidden.'''");
    const result = markdownAnalysis(source);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(!result.names.some(token => ['CODEGEN', 'notes', 'hidden'].includes(token.value)));
    assert.ok(!result.bindings.some(binding => binding.name === 'hidden'));
    const tokens = decodedTokens(source, result);
    assert.equal(tokens.find(token => token.text === '@CODEGEN')?.type, 'keyword');
    assert.ok(tokens.some(token => token.type === 'string' && token.text.includes('@notes')));
    assert.deepEqual(completions(result, after(source, '@notes')), []);
    const partial = markdownSource("> @CTL() @CODE");
    assert.ok(completions(markdownAnalysis(partial), after(partial, '@CODE')).some(item => item.label === 'CODEGEN'));
    assert.match(markdownAnalysis(markdownSource('> @CODEGEN missing_quotes')).diagnostics[0].message, /literal string/);
});

test('CTL completion handles incomplete groups, used settings and restriction keys', () => {
    const items = (body: string) => {
        const source = markdownSource(body);
        const result = markdownAnalysis(source);
        return completions(result, result.document.positionAt(source.length));
    };
    assert.deepEqual(items('> @CTL(').map(item => item.label), ['restrict', 'enforce', 'forbid', 'model', 'reasoning']);
    const settings = items("> @CTL(enforce='Be brief',\n>     rea");
    assert.ok(!settings.some(item => item.label === 'enforce'));
    assert.equal(settings.find(item => item.label === 'reasoning')?.textEdit?.newText, 'reasoning=');
    assert.deepEqual(items("> @CTL(restrict={fs: ['./src'], e").map(item => item.label), ['exec', 'net', 'mcp']);
    assert.deepEqual(items("> @CTL(enforce='Use @no"), []);
    assert.deepEqual(items("> @CTL(restrict={fs: ['@no"), []);
    assert.deepEqual(items('> @CTL(enforce=['), []);
    assert.deepEqual(items("> @CTL(model='arbitrary"), []);
});

test('CTL value completion preserves quotes, full tokens and existing separators', () => {
    for (const [body, needle, label, expected] of [
        ['> @CTL(reasoning=)', 'reasoning=', 'high', "> @CTL(reasoning='high')"],
        ["> @CTL(reasoning='h", "'h", 'high', "> @CTL(reasoning='high'"],
        ['> @CTL(reasoning="medium")', '"me', 'high', '> @CTL(reasoning="high")'],
        ['> @CTL(reasoning="low")', 'reas', 'reasoning', '> @CTL(reasoning="low")'],
        ['> @CTL(restrict={"fs": ["./src"]})', '"f', 'net', '> @CTL(restrict={"net": ["./src"]})'],
    ]) {
        const source = markdownSource(body);
        const result = markdownAnalysis(source);
        const item = completions(result, after(source, needle)).find(item => item.label === label);
        assert.ok(item?.textEdit && 'range' in item.textEdit, body);
        assert.equal(TextDocument.applyEdits(result.document, [item.textEdit]), markdownSource(expected));
    }
    const source = markdownSource('> @CTL(model=)').replace('version: 1', 'version: 1\nmodel: document-model');
    const result = markdownAnalysis(source);
    assert.equal(completions(result, after(source, 'model=')).find(item => item.label === 'document-model')?.textEdit?.newText, "'document-model'");
});

test('blockquote variable completion respects document order, scopes, escaping and UTF-16 ranges', () => {
    const source = markdownSource('```spl\nlet notes = "draft"\nif True:\n    let private = 1\n```\n\n' +
        '> Summarize @notes -> @summary\n\n> Use 😀 @sumSuffix\n\n```spl\nlet future = 1\n```').replace(/\n/g, '\r\n');
    const result = markdownAnalysis(source);
    const items = completions(result, after(source, '😀 @sum'));
    for (const name of ['private', 'future', 'CTL']) assert.ok(!items.some(item => item.label === name), name);
    for (const name of ['notes', 'summary']) assert.ok(items.some(item => item.label === name), name);
    const edit = items.find(item => item.label === 'summary')?.textEdit;
    assert.ok(edit && 'range' in edit);
    assert.ok(TextDocument.applyEdits(result.document, [edit]).includes('> Use 😀 @summary\r\n'));
    for (const marker of ['@@notes', '\\@notes', 'email@notes']) {
        const escaped = markdownSource('> ' + marker);
        assert.deepEqual(completions(markdownAnalysis(escaped), TextDocument.create('', 'markdown', 1, escaped).positionAt(escaped.length)), []);
    }
});

test('CTL literals are not variable references or inferred blockquote outputs', () => {
    const source = markdownSource('```spl\nlet notes = "draft"\n```\n\n' +
        '> @CTL(enforce="save to @hidden", model="@not_a_model_binding") Review @notes -> @summary');
    const result = markdownAnalysis(source);
    assert.ok(!result.names.some(token => ['CTL', 'hidden', 'not_a_model_binding'].includes(token.value)));
    assert.ok(!result.bindings.some(binding => binding.name === 'hidden'));
    assert.ok(result.bindings.some(binding => binding.name === 'summary'));
    assert.equal(definition(result, after(source, '@note'))?.range.start.line, 6);
});

test('blockquote schema completion offers visible types rather than runtime values', () => {
    const source = markdownSource('```spl\nstruct Review:\n    title: str\nlet notes = ""\n```\n\n> @validate[Re');
    const result = markdownAnalysis(source);
    const items = completions(result, result.document.positionAt(source.length));
    for (const name of ['Review', 'str', 'int']) assert.ok(items.some(item => item.label === name), name);
    for (const name of ['notes', 'let', 'CTL']) assert.ok(!items.some(item => item.label === name), name);
});

test('semantic coloring distinguishes multiline CTL syntax, literal values and blockquote variables', () => {
    const source = markdownSource('```spl\nlet notes = "draft"\n```\n\n> @CTL(\n' +
        '>     restrict={fs: ["./src"], exec: ["git"]},\n>     forbid="inventing @hidden", reasoning="high"\n> )\n>\n> Use 😀 @notes.').replace(/\n/g, '\r\n');
    const result = markdownAnalysis(source);
    const tokens = decodedTokens(source, result);
    assert.equal(tokens.find(token => token.text === '@CTL')?.type, 'keyword');
    for (const name of ['restrict', 'fs', 'exec', 'forbid', 'reasoning']) assert.equal(tokens.find(token => token.text === name)?.type, 'property', name);
    for (const value of ['"./src"', '"git"', '"inventing @hidden"', '"high"']) assert.equal(tokens.find(token => token.text === value)?.type, 'string', value);
    assert.ok(!tokens.some(token => token.text === 'hidden'));
    assert.equal(tokens.filter(token => token.text === 'notes').length, 2);
    assert.equal(tokens.findLast(token => token.text === 'notes')?.character, after(source, 'Use 😀 @').character);
});

test('invoice blockquote results have typed completion and shared language features', () => {
    const source = readFileSync(path.resolve(root, '..', 'lang', 'examples', 'extract-invoice.md'), 'utf8');
    const result = markdownAnalysis(source);
    assert.deepEqual(result.diagnostics, []);
    const declaration = at(source, 'invoice', 0);
    const target = at(source, '@invoice');
    target.character++;
    const use = at(source, 'invoice, Invoice');
    assert.equal(completions(result, use).find(item => item.label === 'invoice')?.detail, 'let invoice: Invoice');
    assert.deepEqual(definition(result, use)?.range.start, target);
    assert.match(JSON.stringify(hover(result, use)), /let invoice: Invoice/);
    assert.deepEqual(documentSymbols(result).find(symbol => symbol.name === 'invoice')?.selectionRange.start, target);
    assert.deepEqual(workspaceSymbols([result], 'invoice').find(symbol => symbol.name === 'invoice')?.location.range.start, target);
    assert.ok(references(result, use, true).some(location => location.range.start.line === target.line));
    assert.ok(!references(result, use, false).some(location => location.range.start.line === target.line));
    assert.equal(documentHighlights(result, use).find(highlight => highlight.range.start.line === target.line)?.kind, 3);
    const token = decodedTokens(source, result).find(token => token.line === target.line && token.character === target.character);
    assert.equal(token?.type, 'variable');
    assert.deepEqual(token?.modifiers, ['declaration']);

    const change = rename(result, use, 'bill').documentChanges?.[0];
    assert.ok(change && 'textDocument' in change);
    const updated = TextDocument.applyEdits(result.document, change.edits);
    assert.ok(updated.includes('save to @bill'));
    assert.ok(updated.includes('isinstance(bill, Invoice)'));
    assert.deepEqual(markdownAnalysis(updated).diagnostics, []);

    const typeChange = rename(result, at(source, 'Invoice:'), 'Receipt').documentChanges?.[0];
    assert.ok(typeChange && 'textDocument' in typeChange);
    const renamedType = TextDocument.applyEdits(result.document, typeChange.edits);
    assert.ok(renamedType.includes('@validate[Receipt]'));
    assert.equal(completions(markdownAnalysis(renamedType), use).find(item => item.label === 'invoice')?.detail,
        'let invoice: Receipt');
    assert.equal(definition(result, declaration), undefined, 'Ordinary prose is not a declaration');
});

test('invoice members and line-item members complete with and without validation hints', () => {
    const example = readFileSync(path.resolve(root, '..', 'lang', 'examples', 'extract-invoice.md'), 'utf8');
    for (const source of [example, example.replace('@validate[Invoice] ', '')]) {
        const result = markdownAnalysis(source);
        const fields = completions(result, after(source, 'for line in invoice.'));
        assert.deepEqual(fields.map(item => item.label), ['vendor', 'number', 'date', 'currency', 'lines', 'subtotal', 'tax', 'total']);
        assert.equal(fields.find(item => item.label === 'lines')?.detail, 'lines: list[LineItem]');
        assert.ok(fields.every(item => item.kind === CompletionItemKind.Field));
        const lineFields = completions(result, after(source, 'line.'));
        assert.deepEqual(lineFields.map(item => item.label), ['description', 'quantity', 'unit_price']);
        assert.equal(lineFields.find(item => item.label === 'quantity')?.detail, 'quantity: int');
        const interpolation = completions(result, after(source, 'the subtotal is {invoice.'));
        assert.ok(interpolation.some(item => item.label === 'subtotal'));
        const renamed = rename(result, at(source, 'invoice, Invoice'), 'bill').documentChanges?.[0];
        assert.ok(renamed && 'textDocument' in renamed);
        const updated = TextDocument.applyEdits(result.document, renamed.edits);
        assert.deepEqual(completions(markdownAnalysis(updated), after(updated, 'for line in bill.')).map(item => item.label),
            fields.map(item => item.label));
    }
});

test('member completion recovers partial names and unclosed groups without replacing the receiver', () => {
    const declaration = `struct Data:
    total: int
let value = ask 'Generate'
if isinstance(value, Data):
    `;
    for (const tail of ['value.', 'value.to', 'log(value.', 'log(value.to', 'log(\n        value.']) {
        const source = declaration + tail;
        const result = analysis(source);
        assert.equal(result.diagnostics.length, 1, 'Completion must not hide the original diagnostics');
        const end = result.document.positionAt(source.length);
        const items = completions(result, end);
        assert.deepEqual(items.map(item => item.label), ['total'], tail);
        assert.equal(items[0].detail, 'total: int');
        assert.ok(items[0].textEdit && 'range' in items[0].textEdit);
        assert.deepEqual(items[0].textEdit.range.end, end);
        const updated = TextDocument.applyEdits(result.document, [items[0].textEdit]);
        assert.ok(updated.endsWith('value.total'));
    }
    const source = declaration + "log('😀 {value.to}')";
    const items = completions(analysis(source), after(source, 'value.to'));
    assert.deepEqual(items.map(item => item.label), ['total']);
    assert.ok(items[0].textEdit && 'range' in items[0].textEdit);
    assert.ok(TextDocument.applyEdits(document(source), [items[0].textEdit]).endsWith("log('😀 {value.total}')"));
});

test('lambda parameters have expression-local definitions and references', () => {
    const source = `let x = 10
let first = [1].map(lambda x: x + 1)
let nested = lambda a: lambda b, c: a + b + c
let last = x`;
    const result = analysis(source);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(definition(result, at(source, 'x + 1'))?.range.start, at(source, 'x:'));
    assert.deepEqual(definition(result, at(source, 'x', 3))?.range.start, at(source, 'x', 0));
    assert.deepEqual(definition(result, at(source, 'a + b'))?.range.start, at(source, 'a:'));
    assert.deepEqual(definition(result, at(source, 'b + c'))?.range.start, at(source, 'b, c'));
    assert.ok(completions(result, at(source, 'let last')).every(item => !['a', 'b', 'c'].includes(item.label)));
    assert.ok(completions(result, at(source, 'let last')).some(item => item.label === 'lambda'));
    const partial = 'let f = lambda parameter: par';
    assert.ok(completions(analysis(partial), document(partial).positionAt(partial.length))
        .some(item => item.label === 'parameter'));
});

test('typed lists offer map, filter and reduce completions only on lists', () => {
    const source = 'let xs: list[int] = [1, 2]\nxs.';
    assert.deepEqual(completions(analysis(source), after(source, 'xs.')).map(item => item.label),
        ['map', 'filter', 'reduce']);
    const string = "let xs: str = 'abc'\nxs.";
    assert.deepEqual(completions(analysis(string), after(string, 'xs.')), []);
});

test('member completion follows checker narrowing, shadowing, and reassignment rules', () => {
    const declarations = `struct Left:
    shared: int
    left: str
struct Right:
    shared: int
    right: str
`;
    for (const [body, expected] of [
        ['let value = ask \'Generate\'\nif isinstance(value, Left):\n    value.', ['shared', 'left']],
        ['def inspect(value: Left | Right):\n    if not isinstance(value, Left):\n        value.', ['shared', 'right']],
        ['def inspect(value: Left | Right):\n    if isinstance(value, Left):\n        pass\n    else:\n        value.', ['shared', 'right']],
        ['def inspect(value: Left | Right):\n    isinstance(value, Left) and value.', ['shared', 'left']],
        ['def inspect(value: Left | Right):\n    isinstance(value, Left) or value.', ['shared', 'right']],
        ['def inspect(value: Left | Right):\n    value.', ['shared']],
        ['let value = ask \'Generate\'\nif isinstance(value, Left):\n    pass\nvalue.', []],
        ['let value = ask \'Generate\'\nif isinstance(value, Left):\n    value = object()\n    value.', []],
        ['let value = ask \'Generate\'\nif isinstance(value, Left):\n    let value = object()\n    value.', []],
        ['def isinstance(value, target):\n    return True\nlet value = object()\nif isinstance(value, Left):\n    value.', []],
    ] as const) {
        const source = declarations + body;
        const items = completions(analysis(source), document(source).positionAt(source.length));
        assert.deepEqual(items.map(item => item.label), expected, body);
    }
});

test('typed declarations, nested records, indexed lists, and class methods share member completion', () => {
    const declarations = `struct Item:
    quantity: int
struct Data:
    item: Item
    items: list[Item]
type Alias = Data
class Person:
    name: str
    def label(prefix: str) -> str:
        return prefix + self.name
`;
    for (const [tail, expected] of [
        ['let value: Alias = unknown()\nvalue.', ['item', 'items']],
        ['let value: Data = unknown()\nvalue.item.', ['quantity']],
        ['let value: Data = unknown()\nvalue.items[0].', ['quantity']],
        ['let value = unknown()\nif isinstance(value, Person):\n    value.', ['name', 'label']],
        ['let value: Data = unknown()\nvalue.item.qu', ['quantity']],
        ['let value: Item = unknown()\nvalue.quantity = 1', ['quantity']],
        ['let value: Person = unknown()\nvalue.label(\'x\')', ['name', 'label']],
    ] as const) {
        const source = declarations + tail;
        const result = analysis(source);
        const position = tail.includes('quantity =') ? after(source, 'value.') :
            tail.includes("label('x')") ? after(source, 'value.la') : result.document.positionAt(source.length);
        const items = completions(result, position);
        assert.deepEqual(items.map(item => item.label), expected, tail);
        if (tail.includes('Person')) {
            assert.equal(items.find(item => item.label === 'label')?.kind, CompletionItemKind.Method);
            assert.equal(items.find(item => item.label === 'label')?.detail, 'def label(prefix: str) -> str');
        }
        if (tail.includes("label('x')")) {
            const edit = items.find(item => item.label === 'label')?.textEdit;
            assert.ok(edit && 'range' in edit);
            assert.equal(TextDocument.applyEdits(result.document, [edit]), source, 'Replace the whole existing member name');
        }
    }
});

test('Markdown member edits preserve fence boundaries, CRLF, and typed output visibility', () => {
    const source = markdownSource(`\`\`\`spl
struct Data:
    total: int
\`\`\`

> 😀 @validate[Data] save to @output

\`\`\`spl
log(output.to
\`\`\`
`).replace(/\n/g, '\r\n');
    const result = markdownAnalysis(source);
    const position = after(source, 'output.to');
    const items = completions(result, position);
    assert.deepEqual(items.map(item => item.label), ['total']);
    assert.ok(items[0].textEdit && 'range' in items[0].textEdit);
    assert.deepEqual(items[0].textEdit.range, { start: after(source, 'output.'), end: position });
    const updated = TextDocument.applyEdits(result.document, [items[0].textEdit]);
    assert.ok(updated.includes('log(output.total\r\n```'));
    assert.deepEqual(completions(markdownAnalysis(source.replace('@validate[Data] ', '')), position), []);
});

test('explicit blockquote outputs become visible only after the instruction', () => {
    const source = markdownSource(`\`\`\`spl
log(invoice)
\`\`\`

> Read @document and @invoice, then @validate[str] save it to
> @invoice

\`\`\`spl
log(invoice)
if True:
    let invoice = 1
    log(invoice)
log(invoice)
\`\`\`

> Use @invoice.
`);
    const result = markdownAnalysis(source);
    assert.deepEqual(result.diagnostics, []);
    const target = at(source, '@invoice', 1);
    target.character++;
    assert.equal(definition(result, at(source, 'invoice)', 0)), undefined);
    const input = at(source, '@invoice');
    input.character++;
    assert.equal(definition(result, input), undefined);
    assert.ok(!completions(result, input).some(item => item.label === 'invoice'));
    assert.ok(!completions(result, input).some(item => item.label === 'document'));
    assert.deepEqual(definition(result, at(source, 'invoice)', 1))?.range.start, target);
    assert.deepEqual(definition(result, at(source, 'invoice)', 2))?.range.start, at(source, 'invoice ='));
    assert.deepEqual(definition(result, at(source, 'invoice)', 3))?.range.start, target);
    const later = at(source, '@invoice', 2);
    later.character++;
    const completion = completions(result, later).find(item => item.label === 'invoice');
    assert.equal(completion?.detail, 'let invoice: str');
    assert.equal(completion?.textEdit?.newText, 'invoice');
    assert.ok(completion?.textEdit && 'range' in completion.textEdit);
    assert.deepEqual(completion.textEdit.range.start, later);
    assert.deepEqual(definition(result, later)?.range.start, target);
});

test('blockquote save and arrow conventions infer declared types but not dynamic schemas', () => {
    for (const instruction of ['Save to @output', 'save it to @output', 'Save the answer to @output',
        'Save a dict mapping keys to values to @output', 'Produce a value -> @output']) {
        const source = markdownSource(`> ${instruction}\n\n\`\`\`spl\nlog(output)\n\`\`\``);
        const result = markdownAnalysis(source);
        assert.deepEqual(result.diagnostics, []);
        assert.equal(completions(result, at(source, 'log(output)')).find(item => item.label === 'output')?.detail,
            'let output: unknown', instruction);
    }
    for (const [declaration, type] of [
        ['type Money = int', 'Money'],
        ["enum Color = 'red' | 'blue'", 'Color'],
        ['struct Data:\n    value: str', 'Data'],
        ['hydratable class Person:\n    name: str', 'Person'],
        ['let Schema = object()', 'unknown'],
        ['if True:\n    struct Schema:\n        value: str', 'unknown'],
        ['', 'unknown'],
    ]) {
        const schema = type === 'unknown' ? 'Schema' : type;
        const source = markdownSource(`\`\`\`spl\n${declaration || 'pass'}\n\`\`\`\n\n> @validate[${schema}] save to @output\n\n\`\`\`spl\nlog(output)\n\`\`\``);
        const result = markdownAnalysis(source);
        assert.deepEqual(result.diagnostics, []);
        assert.equal(completions(result, at(source, 'log(output)')).find(item => item.label === 'output')?.detail,
            `let output: ${type}`, declaration);
    }
});

test('validation hints are local to their blockquote and associated with each output', () => {
    const source = markdownSource(`> @validate[int] Save to @first. @validate[str] Save to @second.

> Save to @third

> Save to @fourth @validate[bool]

\`\`\`spl
log(first, second, third, fourth)
\`\`\``);
    const result = markdownAnalysis(source);
    assert.deepEqual(result.diagnostics, []);
    const items = completions(result, at(source, 'log(first'));
    for (const [name, type] of [['first', 'int'], ['second', 'str'], ['third', 'unknown'], ['fourth', 'bool']]) {
        assert.equal(items.find(item => item.label === name)?.detail, `let ${name}: ${type}`);
    }
});

test('blockquote saves preserve existing declarations and ignore escaped or ordinary prose targets', () => {
    const source = markdownSource(`\`\`\`spl
let existing: str = 'before'
\`\`\`

Save to @prose

> Save to @existing. Save to @new. Save it to @new.
> Use @input. Save to @@escaped. Save to email@address.

> @validate[str] Save to @new

\`\`\`spl
log(existing, new)
\`\`\``);
    const result = markdownAnalysis(source);
    assert.deepEqual(result.diagnostics, []);
    const items = completions(result, at(source, 'log(existing'));
    assert.equal(items.find(item => item.label === 'existing')?.detail, 'let existing: str');
    assert.equal(items.find(item => item.label === 'new')?.detail, 'let new: unknown');
    for (const name of ['prose', 'input', 'escaped', 'address']) {
        assert.ok(!items.some(item => item.label === name), name);
    }
    assert.equal(documentSymbols(result).filter(symbol => symbol.name === 'new').length, 1);
    assert.deepEqual(definition(result, at(source, 'existing, new'))?.range.start, at(source, 'existing:'));
});

test('blockquote output and validation positions preserve CRLF and UTF-16 offsets', () => {
    const source = markdownSource(`\`\`\`spl
struct Data:
    value: str
\`\`\`

> 😀 @validate[Data] save to @output

\`\`\`spl
log(output)
\`\`\``).replace(/\n/g, '\r\n');
    const result = markdownAnalysis(source);
    assert.deepEqual(result.diagnostics, []);
    const target = at(source, '@output');
    target.character++;
    assert.deepEqual(definition(result, at(source, 'output)'))?.range.start, target);
    assert.deepEqual(definition(result, at(source, 'Data]'))?.range.start, at(source, 'Data:'));
    assert.equal(completions(result, at(source, 'output)')).find(item => item.label === 'output')?.detail,
        'let output: Data');
    const change = rename(result, target, 'result').documentChanges?.[0];
    assert.ok(change && 'textDocument' in change);
    assert.ok(TextDocument.applyEdits(result.document, change.edits).includes('save to @result\r\n'));
});

test('type diagnostics retain built-in and declared types after preceding control flow', () => {
    const source = `let path = 'invoice.txt'
if $args[0] != None:
    path = $args[0]
struct Money:
    amount: int
enum Severity = 'low' | 'high'
while False:
    pass
struct Finding:
    amount: Money
    severity: Severity`;
    assert.deepEqual(analysis(source).diagnostics, []);
    assert.deepEqual(markdownAnalysis(markdownSource(`\`\`\`spl\n${source}\n\`\`\``)).diagnostics, []);
    const invalid = source + '\nlet bad: int = 1.5';
    assert.match(analysis(invalid).diagnostics[0].message, /int|float/);
});

test('Markdown indentation scopes end at their fence, before natural-language references', () => {
    const source = markdownSource('```spl\nlet shared = 1\nif True:\n    let hidden = 2\n```\n\n> Use @shared and @hidden.\n\n```spl\nlog(shared)\n```');
    const result = markdownAnalysis(source);
    assert.deepEqual(result.diagnostics, []);
    const shared = at(source, '@shared');
    shared.character++;
    const hidden = at(source, '@hidden');
    hidden.character++;
    assert.deepEqual(definition(result, shared)?.range.start, at(source, 'shared'));
    assert.equal(definition(result, hidden), undefined);
    assert.ok(!completions(result, hidden).some(item => item.label === 'hidden'));
});

test('indentation diagnostics, scope boundaries and editing defaults stay aligned', () => {
    assert.match(analysis('if True { pass }').diagnostics[0].message, /brace-delimited blocks/);
    assert.match(analysis('if True:\npass').diagnostics[0].message, /indented block/);
    assert.match(analysis('if True:\n\tpass').diagnostics[0].message, /tabs/);
    const source = 'let outer = 1\nlet data = object:\n    "key": outer\nif True:\n    let local = data\n    log(local)';
    const result = analysis(source);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.scopes.length, 2, 'Dictionaries do not introduce lexical scopes');
    assert.deepEqual(definition(result, at(source, 'outer', 1))?.range.start, at(source, 'outer'));
    assert.ok(completions(result, document(source).positionAt(source.length)).some(item => item.label === 'local'));
    const configuration = JSON.parse(readFileSync(path.resolve(root, 'language-configuration.json'), 'utf8'));
    assert.equal(configuration.folding.offSide, true);
    const increase = new RegExp(configuration.indentationRules.increaseIndentPattern);
    for (const header of ['if True:', 'def f(): # body', 'else:', 'let value = :', 'let data = object:', 'struct Data:', 'hydratable class Person:']) {
        assert.ok(increase.test(header), header);
    }
    assert.ok(!increase.test('let removed = {'));
    assert.ok(!configuration.autoClosingPairs.some((pair: { open: string }) => pair.open === '{'));
    const manifest = JSON.parse(readFileSync(path.resolve(root, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.contributes.configurationDefaults['[spl]'], {
        'editor.insertSpaces': true, 'editor.tabSize': 4, 'editor.detectIndentation': false,
    });
    assert.ok(manifest.activationEvents.includes('onLanguage:spl'));
    assert.deepEqual(manifest.contributes.languages.find((language: { id: string }) => language.id === 'spl').extensions, ['.spl']);

});

test('typed declarations, annotated parameters and object properties retain lexical navigation', () => {
    const source = `enum Color = 'red' | 'blue'
struct Data:
    color: Color
hydratable class Person:
    name: str

    def Person(name: str):
        self.name = name

    def greeting() -> str:
        return self.name
let label: str = 'Ada'
let data = object:
    'name': label
    def render(callback: fn(str, int) -> str, count: int) -> str:
        return callback(label, count)
success data`;
    const result = analysis(source);
    assert.deepEqual(result.diagnostics, []);
    const symbols = documentSymbols(result);
    for (const [name, kind] of [['Color', SymbolKind.Enum], ['Data', SymbolKind.Struct], ['Person', SymbolKind.Class]] as const) {
        assert.equal(symbols.find(symbol => symbol.name === name)?.kind, kind);
    }
    assert.deepEqual(symbols.find(symbol => symbol.name === 'Person')?.children?.map(symbol => symbol.name),
        ['name', 'Person', 'greeting']);
    assert.deepEqual(symbols.find(symbol => symbol.name === 'Data')?.children?.map(symbol => symbol.name), ['color']);
    assert.deepEqual(definition(result, at(source, 'label', 1))?.range.start, at(source, 'label'));
    assert.deepEqual(definition(result, at(source, 'count)', 0))?.range.start, at(source, 'count:'));
    const visible = completions(result, at(source, 'return callback'));
    assert.ok(visible.some(item => item.label === 'callback'));
    assert.ok(!visible.some(item => item.label === 'int' && item.detail === 'parameter int'));
    assert.ok(!completions(result, at(source, 'success')).some(item => item.label === 'render'),
        'Inline object functions are properties, not lexical bindings');
    assert.ok(!completions(result, at(source, 'success')).some(item => item.label === 'greeting'));
    assert.match(JSON.stringify(hover(result, at(source, 'label'))), /let label: str/);
    assert.match(JSON.stringify(hover(result, at(source, 'render'))), /fn.*str, int.*str/);
});

test('type aliases have navigation, hover, completion and semantic tokens without changing type()', () => {
    const source = `type Money = int [minimum=0, desc='Cents']
let amount: Money = 1250
type(amount)`;
    const result = analysis(source);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(documentSymbols(result).find(symbol => symbol.name === 'Money')?.kind, SymbolKind.TypeParameter);
    assert.deepEqual(definition(result, at(source, 'Money', 1))?.range.start, at(source, 'Money'));
    assert.ok(completions(result, at(source, 'type(amount)')).some(item => item.label === 'Money'));
    assert.match(JSON.stringify(hover(result, at(source, 'Money', 1))), /type Money = int/);
    assert.match(JSON.stringify(hover(result, at(source, 'type Money'))), /transparent/);
    assert.match(JSON.stringify(hover(result, at(source, 'type(amount)'))), /type\(value\)/);
    const tokens = decodedTokens(source, result);
    assert.deepEqual(tokens.filter(token => token.text === 'Money').map(token => token.type), ['type', 'type']);
    assert.deepEqual(tokens.filter(token => token.text === 'type').map(token => token.type), ['keyword', 'function']);
});

test('static typed failures are editor errors without inventing errors for untyped unknown values', () => {
    assert.match(analysis("let count: int = 1.0").diagnostics[0].message, /int|float/);
    assert.equal(analysis("let dynamic = missing_name").diagnostics.length, 0);
    assert.match(analysis("let data = {'name': 'Ada'}").diagnostics[0].message, /object|dictionary|brace/);
    assert.match(analysis("if True:\n  pass").diagnostics[0].message, /four|4/);
});

function at(source: string, text: string, occurrence = 0) {
    let index = -1;
    for (let i = 0; i <= occurrence; i++) {
        index = source.indexOf(text, index + 1);
        assert.notEqual(index, -1, `Missing ${text}`);
    }
    return document(source).positionAt(index);
}

test('diagnostics use the real parser with zero-based, UTF-16 positions', () => {
    const source = "let emoji = '😀'; let x = ask(unknown=1) 'hello'";
    const result = analysis(source);
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0].message, /unknown modifier 'unknown'/);
    assert.deepEqual(result.diagnostics[0].range.start, at(source, 'unknown'));
    assert.equal(result.diagnostics[0].source, 'spl');
    assert.equal(result.diagnostics[0].severity, 1);
    assert.match(analysis("let x = ask(fmt='json', fmt='text') 'x'").diagnostics[0].message, /duplicate modifier/);
    assert.match(analysis("let x = '\\q'").diagnostics[0].message, /invalid escape/);
    assert.match(analysis('break').diagnostics[0].message, /outside of a loop/);
    assert.equal(analysis('let x = missing_name').diagnostics.length, 0, 'Do not invent runtime diagnostics');
    assert.equal(analysis('let x =').diagnostics[0].range.start.character, 7);
});

test('all shipped examples parse without diagnostics', () => {
    const examples = path.resolve(root, '..', 'lang', 'examples');
    const files = readdirSync(examples).filter((file) => file.endsWith('.md'));
    assert.ok(files.length > 0);
    for (const file of files) {
        assert.deepEqual(analyze(TextDocument.create(`file:///${file}`, 'markdown', 1, readFileSync(path.join(examples, file), 'utf8'))).diagnostics, [], file);
    }
});

test('human input has keyword help and no model modifier completion', () => {
    const source = "let answer = human 'Review this draft'";
    assert.deepEqual(analysis(source).diagnostics, []);
    assert.match(JSON.stringify(hover(analysis(source), at(source, 'human'))?.contents), /Human input/);
    assert.ok(completions(analysis(''), { line: 0, character: 0 }).some((item) => item.label === 'human'));
    const incomplete = 'human (';
    const items = completions(analysis(incomplete), document(incomplete).positionAt(incomplete.length));
    for (const name of MODIFIER_NAMES) assert.ok(!items.some((item) => item.label === name && item.textEdit?.newText === `${name}=`));
    assert.match(analysis("human(fmt='text') 'question'").diagnostics[0].message, /does not accept modifiers/);
});

test('ask has sampling modifiers, completions and help without changing think or agent', () => {
    const source = "let answer = ask(seed=42, temperature=0, top_p=0.01, fmt='integer') 'Prompt'";
    const result = analysis(source);
    assert.deepEqual(result.diagnostics, []);
    assert.match(JSON.stringify(hover(result, at(source, 'ask'))?.contents), /sampling controls apply only to ask/);
    for (const name of ['seed', 'temperature', 'top_p']) {
        assert.match(JSON.stringify(hover(result, at(source, `${name}=`))?.contents), /ask/);
    }
    for (const prefix of ['ask(', 'ask(\n    ', 'ask(seed=42, te']) {
        const items = completions(analysis(prefix), document(prefix).positionAt(prefix.length));
        assert.deepEqual(items.map(item => item.label), [...ASK_MODIFIER_NAMES]);
        for (const item of items) assert.equal(item.textEdit?.newText, `${item.label}=`);
    }
    for (const command of ['think', 'agent']) {
        const call = `${command}(`;
        assert.deepEqual(completions(analysis(call), document(call).positionAt(call.length)).map(item => item.label), [...MODIFIER_NAMES]);
        for (const name of ['seed', 'temperature', 'top_p']) {
            assert.match(analysis(`${command}(${name}=0) 'Prompt'`).diagnostics[0].message, /unknown modifier/);
        }
    }
    assert.ok(!completions(analysis(''), { line: 0, character: 0 }).some(item => item.label === 'randomness'));
    assert.ok(analysis("randomness(seed=1) ask 'Prompt'").diagnostics.length > 0);
    assert.match(analysis("ask(bad=1) 'Prompt'").diagnostics[0].message, /unknown modifier/);
    assert.deepEqual(analysis('let randomness = 1').diagnostics, []);
});

test('generation token budgets have syntax support, completion and hover help', () => {
    for (const command of ['ask', 'think', 'agent']) {
        const source = `${command}(tokens=2048) 'Prompt'`;
        const result = analysis(source);
        assert.deepEqual(result.diagnostics, []);
        assert.match(JSON.stringify(hover(result, at(source, 'tokens'))?.contents), /Maximum generated tokens per model turn/);
        const prefix = `${command}(tok`;
        const items = completions(analysis(prefix), document(prefix).positionAt(prefix.length));
        assert.equal(items.find(item => item.label === 'tokens')?.textEdit?.newText, 'tokens=');
    }
    assert.match(analysis("ask(tokens=1, tokens=2) 'Prompt'").diagnostics[0].message, /duplicate modifier/);
});

test('eval is no longer syntax or a keyword completion', () => {
    assert.ok(analysis("eval(expected='x', actual='x', cutoff=0.9)").diagnostics.length > 0);
    assert.ok(!completions(analysis(''), { line: 0, character: 0 }).some(item => item.label === 'eval'));
    assert.equal(hover(analysis('eval'), { line: 0, character: 0 }), undefined);
    const source = 'def eval(value):\n    return value\nsuccess eval(42)';
    const result = analysis(source);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(definition(result, at(source, 'eval', 1))?.range.start.line, 0);
    assert.deepEqual(analysis('let eval = 1').diagnostics, []);
});

test('all snippets expand to valid current SPL syntax', () => {
    const snippets: Record<string, { body: string[] }> = JSON.parse(readFileSync(
        path.resolve(root, 'snippets', 'spl.code-snippets'), 'utf8',
    ));
    for (const [name, snippet] of Object.entries(snippets)) {
        const source = snippet.body.join('\n')
            .replace(/\$\{\d+\|([^}]+)\|\}/g, (_, choices: string) => choices.split(',')[0])
            .replace(/\$\{\d+:([^}]*)\}/g, '$1')
            .replace(/\$\d+/g, '');
        assert.deepEqual(analysis(source).diagnostics, [], name);
    }
});

test('builtin completions stay aligned with the runtime', () => {
    const runtimeNames = [...makeBuiltins({ log() {} }).keys(), 'char', 'object', 'validate', 'isinstance', 'struct',
        'read_file', 'write_file', 'web_fetch', 'web_search', 'shell'];
    assert.deepEqual(Object.keys(builtins).sort(), runtimeNames.sort());
    const items = completions(analysis(''), { line: 0, character: 0 });
    for (const name of [...runtimeNames, 'let', 'def', 'ask', 'think', 'agent', 'enforce', 'forbid', 'restrict']) {
        assert.ok(items.some((item) => item.label === name), name);
    }
    assert.ok(!items.some((item) => ['instruct', 'avoid', 'level'].includes(item.label)));
});

test('special variables have diagnostics, completion edits and hover without runtime access', () => {
    const source = "let args = $args\nsuccess [$env.SPL_TEST, $args[0], '{$env.SPL_TEST}: {$args[1]}']";
    const result = analysis(source);
    assert.deepEqual(result.diagnostics, []);
    for (const name of ['$env', '$args']) {
        const help = hover(result, at(source, name));
        assert.match(JSON.stringify(help?.contents), /[Rr]ead-only/);
        assert.match(JSON.stringify(help?.contents), /None/);
        assert.equal(definition(result, at(source, name)), undefined);
    }
    assert.match(JSON.stringify(hover(result, at(source, '$env', 1))?.contents), /process environment/);
    assert.match(analysis('let $args = []').diagnostics[0].message, /special variable/);
    assert.match(analysis('success $unknown').diagnostics[0].message, /unknown special variable/);
    for (const prefix of ['$', '$ar', '$en']) {
        const partial = `success ${prefix}`;
        const end = document(partial).positionAt(partial.length);
        const items = completions(analysis(partial), end);
        for (const name of ['$env', '$args']) {
            assert.deepEqual(items.find((item) => item.label === name)?.textEdit, {
                range: { start: at(partial, prefix), end },
                newText: name,
            });
        }
    }
    assert.deepEqual(documentSymbols(result).map((symbol) => symbol.name), ['args']);
});

test('modifier and directive completions replace partial identifiers', () => {
    const source = "let response = ask(rea) 'hello'";
    const items = completions(analysis(source), document(source).positionAt(source.indexOf('rea') + 3));
    assert.deepEqual(items.map((item) => item.label), [...ASK_MODIFIER_NAMES]);
    assert.deepEqual(items.find((item) => item.label === 'reasoning')?.textEdit, {
        range: { start: at(source, 'rea'), end: document(source).positionAt(source.indexOf('rea') + 3) },
        newText: 'reasoning=',
    });
    assert.equal(items.find(item => item.label === 'hide')?.textEdit?.newText, 'hide=');
    assert.ok(!items.some(item => item.label === 'show'));
    for (const call of ['ask', 'think', 'agent']) {
        const text = `let x = ${call}(`;
        assert.deepEqual(completions(analysis(text), document(text).positionAt(text.length)).map((item) => item.label),
            [...(call === 'ask' ? ASK_MODIFIER_NAMES : MODIFIER_NAMES)]);
    }
    assert.deepEqual(completions(analysis('@('), { line: 0, character: 2 }).map((item) => item.label), ['model']);
    const log = 'log(le';
    assert.deepEqual(completions(analysis(log), document(log).positionAt(log.length)).map((item) => item.label), ['level']);
    assert.ok(completions(analysis('let value = ('), { line: 0, character: 13 }).some((item) => item.label === 'range'));
});

test('hover distinguishes builtin calls, generation modifiers, and user bindings', () => {
    const source = "let values = []\nlet answer = ask(len='sentence') 'hello'\nlog(len(values))";
    const result = analysis(source);
    const modifier = hover(result, at(source, 'len'));
    const builtin = hover(result, at(source, 'len', 1));
    assert.match(JSON.stringify(modifier?.contents), /Requested output length/);
    assert.match(JSON.stringify(builtin?.contents), /len\(value\)/);
    assert.match(JSON.stringify(hover(result, at(source, 'values', 1))?.contents), /let values/);
    assert.equal(hover(analysis('constructor'), { line: 0, character: 0 }), undefined);
    assert.equal(hover(analysis('# len'), { line: 0, character: 2 }), undefined);
    assert.equal(hover(analysis("log('len')"), { line: 0, character: 5 }), undefined);
    const hidden = "ask(hide=True) 'hello'";
    assert.match(JSON.stringify(hover(analysis(hidden), at(hidden, 'hide'))?.contents), /Suppress model reasoning.*Defaults to False/);
    assert.match(analysis("ask(show=True) 'hello'").diagnostics[0].message, /unknown modifier.*show/);
});

test('multiline modifiers preserve contexts through nested values and unfinished parentheses', () => {
    const source = `let result = ask(
    schema=object:
        'type': 'integer'
    ,
    model=choose('one', 'two'),
    rea
) 'prompt'`;
    assert.deepEqual(
        completions(analysis(source), document(source).positionAt(source.indexOf('rea') + 3)).map((item) => item.label),
        [...ASK_MODIFIER_NAMES],
    );
    const incomplete = `let result = ask(
    fmt='integer',
    rep`;
    assert.deepEqual(
        completions(analysis(incomplete), document(incomplete).positionAt(incomplete.length)).map((item) => item.label),
        [...ASK_MODIFIER_NAMES],
    );
    for (const source of ["let result = ask(model=choose(", "log(", "object.log("]) {
        const items = completions(analysis(source), document(source).positionAt(source.length));
        assert.ok(items.some((item) => item.label === 'range'), source);
    }
    for (const source of ["log('value', ", 'log(value, ']) {
        const items = completions(analysis(source), document(source).positionAt(source.length));
        assert.ok(items.some((item) => item.label === 'range'), source);
        assert.ok(!items.some((item) => item.label === 'level'), source);
    }
    const log = 'log(\n    le';
    assert.deepEqual(
        completions(analysis(log), document(log).positionAt(log.length)).map((item) => item.label), ['level'],
    );
    assert.match(JSON.stringify(hover(analysis("ask(fmt='integer') 'prompt'"), { line: 0, character: 1 })?.contents), /Generation-only/);
    for (const [source, expected] of [
        ["?{fmt='integer'} 'prompt'", /use ask/],
        ["agent{reasoning='high'} 'prompt'", /use agent/],
        ["log{level=debug}(1)", /use log/],
        ["@{model='test'}", /use @/],
    ] as const) {
        assert.match(analysis(source).diagnostics[0].message, expected);
    }
});

test('format hover and completions describe every supported output type', () => {
    const source = "let answer = ask(fmt='integer') 'Fibonacci of 10'";
    const formats = ['integer', 'float', 'array', 'object', 'text', 'boolean', 'json'];
    const help = JSON.stringify(hover(analysis(source), at(source, 'fmt'))?.contents);
    const partial = 'let answer = ask(fm';
    const item = completions(analysis(partial), document(partial).positionAt(partial.length)).find((entry) => entry.label === 'fmt');
    for (const format of formats) {
        assert.ok(help.includes(`'${format}'`), format);
        assert.ok(JSON.stringify(item).includes(`'${format}'`), format);
    }
    assert.match(help, /object excludes arrays/);
});

test('navigation and completions respect block and function scopes', () => {
    const source = [
        'let outer = 1',
        'def first(value):',
        '    if True:',
        '        let local = value',
        '    return local + outer',
        'def second(value):',
        '    return value',
        'success outer',
    ].join('\n');
    const result = analysis(source);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(definition(result, at(source, 'local +')), undefined);
    assert.deepEqual(definition(result, at(source, 'outer', 1))?.range.start, at(source, 'outer'));
    assert.deepEqual(definition(result, at(source, 'value\n'))?.range.start, at(source, 'value'));
    assert.deepEqual(definition(result, at(source, 'value\n', 1))?.range.start, at(source, 'value', 2));
    const outside = completions(result, at(source, 'success')).map((item) => item.label);
    assert.ok(!outside.includes('local'));
    assert.ok(!outside.includes('value'));
    const inside = completions(result, at(source, 'return local')).map((item) => item.label);
    assert.ok(!inside.includes('local'));
    assert.ok(inside.includes('outer'));
    assert.ok(inside.includes('value'));
});

test('definitions restore shadowed names and hide loop and handler bindings', () => {
    const source = [
        'let x = 1',
        ':',
        '    let x = 2',
        '    log(x)',
        'log(x)',
        'for i in [1]:',
        '    log(i)',
        'try:',
        '    fail \'x\'',
        'except err:',
        '    log(err)',
        'log(i, err)',
        'let value = if True:',
        '    let hidden = 3',
        '    hidden',
        'else:',
        '    0',
        'log(hidden)',
        'log(level=debug)(value)',
    ].join('\n');
    const result = analysis(source);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(definition(result, at(source, 'x)'))?.range.start, at(source, 'x = 2'));
    assert.deepEqual(definition(result, at(source, 'x)', 1))?.range.start, at(source, 'x = 1'));
    assert.equal(definition(result, at(source, 'i, err')), undefined);
    assert.equal(definition(result, at(source, 'err)', 1)), undefined);
    assert.equal(definition(result, at(source, 'hidden)', 0)), undefined);
    assert.match(JSON.stringify(hover(result, at(source, 'level'))?.contents), /Log severity/);
});

test('definitions handle nested functions, conflicting redeclarations, loop and exception bindings', () => {
    const source = [
        'let name = 1',
        'let name = 2',
        'def outer(param):',
        '    def inner():',
        '        return param + name',
        '    return inner()',
        'for i, item in enumerate([]):',
        '    log(i, item)',
        'try:',
        '    fail \'x\'',
        'except err:',
        '    log(err.reason)',
    ].join('\n');
    const result = analysis(source);
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0].message, /conflicting declaration 'name'/);
    assert.deepEqual(definition(result, at(source, 'name', 2))?.range.start, at(source, 'name', 1));
    assert.deepEqual(definition(result, at(source, 'param +'))?.range.start, at(source, 'param'));
    assert.deepEqual(definition(result, at(source, 'inner()', 1))?.range.start, at(source, 'inner'));
    assert.deepEqual(definition(result, at(source, 'i, item', 1))?.range.start, at(source, 'i, item'));
    assert.deepEqual(definition(result, at(source, 'item)'))?.range.start, at(source, 'item'));
    assert.deepEqual(definition(result, at(source, 'err.reason'))?.range.start, at(source, 'err'));
    assert.equal(definition(result, at(source, 'reason')), undefined, 'Member names are not variable references');
});

test('interpolation references retain exact positions, raw strings and escapes do not resolve', () => {
    const source = [
        'let name = 1',
        'log("😀 {name} {{name}}")',
        "log(r'{name}')",
        "log('''first",
        '{name}',
        "last''')",
    ].join('\n');
    const result = analysis(source);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(definition(result, at(source, 'name', 1))?.range.start, at(source, 'name'));
    assert.equal(definition(result, at(source, 'name', 2)), undefined);
    assert.equal(definition(result, at(source, 'name', 3)), undefined);
    assert.deepEqual(definition(result, at(source, 'name', 4))?.range.start, at(source, 'name'));
});

test('references inside indented interpolation suites keep their original locations', () => {
    const source = `let shared = 1
if True:
    log('''{if False:
        shared
    else:
        shared
    }''')
success shared`;
    const result = analysis(source);
    assert.deepEqual(result.diagnostics, []);
    for (const occurrence of [1, 2, 3]) {
        assert.deepEqual(definition(result, at(source, 'shared', occurrence))?.range.start, at(source, 'shared'));
    }
});

test('symbols include nested functions and block bindings with valid selection ranges', () => {
    const source = "let x = 1\ndef foo(param):\n    if True:\n        let nested = param\n:\n    let visible = 2";
    const symbols = documentSymbols(analysis(source));
    assert.deepEqual(symbols.map((symbol) => symbol.name), ['x', 'foo', 'visible']);
    const fn = symbols[1];
    assert.equal(fn.kind, SymbolKind.Function);
    assert.deepEqual(fn.children?.map((symbol) => symbol.name), ['nested']);
    assert.deepEqual(fn.selectionRange.start, at(source, 'foo'));
    assert.deepEqual(fn.range.end, at(source, ':\n    let visible'));
});

test('the language server never executes source', () => {
    const source = "let output = shell('must-not-run')\nwrite_file('must-not-exist', 'x')\nlet response = agent 'must-not-call-model'";
    assert.deepEqual(analysis(source).diagnostics, []);
});

test('references and highlights follow shadowing, writes, parameters and interpolations', () => {
    const source = `let value = 1
if True:
    let value = 2
    value += 1
    log('😀 {value} {{value}}')
log(value)
def render(value):
    return value`;
    const result = analysis(source);
    assert.deepEqual(references(result, at(source, 'value'), true).map(location => location.range.start),
        [at(source, 'value'), at(source, 'value)', 0)]);
    const inner = at(source, 'value = 2');
    assert.deepEqual(references(result, inner, false).map(location => location.range.start),
        [at(source, 'value +='), at(source, 'value}', 0)]);
    assert.deepEqual(documentHighlights(result, inner).map(highlight => highlight.kind), [3, 3, 2]);
    assert.deepEqual(references(result, at(source, 'return value'), true), []);
    const param = at(source, 'value):');
    assert.equal(references(result, param, true).length, 2);
    assert.deepEqual(references(result, at(source, 'log'), true), []);
});

test('rename is versioned, scope-aware, and includes only real Markdown and string references', () => {
    const source = markdownSource(`Comment @count

\`\`\`spl
let count = 1
log('😀 {count} {{count}}', r'{count}')
\`\`\`

> Use @count, not @@count or email@count.

\`\`\`spl
success count
\`\`\``);
    const result = markdownAnalysis(source);
    const position = at(source, 'count =');
    assert.deepEqual(prepareRename(result, position), { range: {
        start: position, end: { ...position, character: position.character + 5 },
    }, placeholder: 'count' });
    const change = rename(result, position, 'total').documentChanges?.[0];
    assert.ok(change && 'textDocument' in change);
    assert.equal(change.textDocument.version, 1);
    assert.equal(change.edits.length, 4);
    const updated = TextDocument.applyEdits(result.document, change.edits);
    assert.ok(updated.includes('Comment @count'));
    assert.ok(updated.includes("{{count}}', r'{count}'"));
    assert.ok(updated.includes('@total, not @@count or email@count'));
    assert.deepEqual(markdownAnalysis(updated).diagnostics, []);
});

test('rename rejects invalid names, same-scope conflicts and capture in either direction', () => {
    const source = 'let value = 1\nlet other = 2\nlog(value, other)';
    for (const newName of ['other', 'let', 'len', '$value', 'bad-name', '1value', '']) {
        assert.throws(() => rename(analysis(source), at(source, 'value'), newName), ResponseError, newName);
    }
    const shadow = 'let value = 1\nif True:\n    let local = 2\n    log(value)';
    assert.throws(() => rename(analysis(shadow), at(shadow, 'value'), 'local'), /capture|shadow/);
    const capture = 'let outer = 1\nif True:\n    let local = 2\n    log(outer)';
    assert.throws(() => rename(analysis(capture), at(capture, 'local'), 'outer'), /capture|shadow/);
    const unknown = 'let value = 1\nlog(future)';
    assert.throws(() => rename(analysis(unknown), at(unknown, 'value'), 'future'), /capture|shadow/);
    assert.equal(prepareRename(analysis('log(unknown)'), at('log(unknown)', 'unknown')), undefined);
    assert.throws(() => rename(analysis('log(unknown)'), at('log(unknown)', 'unknown'), 'valid'), /Only declared/);
});

test('fields and modifiers do not masquerade as lexical references or rename targets', () => {
    const source = `let name = 'Ada'
struct Person:
    name: str
let fmt = 'json'
ask(fmt=fmt) 'x'`;
    const result = analysis(source);
    assert.equal(prepareRename(result, at(source, 'name:')), undefined);
    assert.equal(prepareRename(result, at(source, 'fmt=')), undefined);
    assert.equal(references(result, at(source, 'name ='), true).length, 1);
    assert.equal(references(result, at(source, 'fmt ='), true).length, 2);
    assert.equal(documentSymbols(result).find(symbol => symbol.name === 'Person')?.children?.[0].kind, SymbolKind.Field);
});

test('signature help handles typed functions, nested calls, overloads and modifier arguments', () => {
    const source = `def render(callback: fn(str, int) -> str, count: int) -> str:
    return callback('x', count)
render(len([1, 2]), `;
    const result = analysis(source);
    const help = signatureHelp(result, document(source).positionAt(source.length));
    assert.equal(help?.signatures[0].label, 'def render(callback: fn(str, int) -> str, count: int) -> str');
    assert.equal(help?.signatures[0].parameters?.length, 2);
    assert.equal(help?.activeParameter, 1);
    const nested = at(source, '2])');
    assert.equal(signatureHelp(result, nested), undefined, 'No call help inside a list literal');
    const call = 'range(1, ';
    const range = signatureHelp(analysis(call), document(call).positionAt(call.length));
    assert.equal(range?.activeSignature, 1);
    assert.equal(range?.activeParameter, 1);
    for (const command of ['ask', 'think', 'agent']) {
        const call = `${command}(model='test', tokens=2048, schema=Shape`;
        const help = signatureHelp(analysis(call), document(call).positionAt(call.length));
        assert.ok(help);
        const parameter = help.signatures[0].parameters?.[help.activeParameter!];
        assert.ok(parameter && Array.isArray(parameter.label));
        assert.ok(help.signatures[0].label.slice(...parameter.label).startsWith('schema='));
        assert.equal(help.signatures[0].label.includes('seed='), command === 'ask');
    }
});

test('lambda parameter commas are not counted as call arguments in signature help', () => {
    const declaration = 'def apply(callback, initial):\n    return initial\n';
    for (const tail of ['apply(lambda x, y', 'apply(lambda x, y: x + y']) {
        const source = declaration + tail;
        assert.equal(signatureHelp(analysis(source), document(source).positionAt(source.length))?.activeParameter, 0);
    }
    const source = declaration + 'apply(lambda x, y: x + y, ';
    assert.equal(signatureHelp(analysis(source), document(source).positionAt(source.length))?.activeParameter, 1);
});

test('signature help ignores comments, strings, member calls, declarations and shadowed built-ins', () => {
    for (const source of ['def f(value', '# len(', "let text = 'len('", 'unknown(', 'obj.len(']) {
        assert.equal(signatureHelp(analysis(source), document(source).positionAt(source.length)), undefined, source);
    }
    const shadow = 'let len = 1\nlen(';
    assert.equal(signatureHelp(analysis(shadow), document(shadow).positionAt(shadow.length)), undefined);
    const source = "let text = '{round(1, 2)}'";
    assert.equal(signatureHelp(analysis(source), at(source, '2)}'))?.activeParameter, 1);
    const plain = '# ordinary\n\n```spl\nlen(\n```';
    assert.equal(signatureHelp(markdownAnalysis(plain), at(plain, 'len(')), undefined);
});

test('folding ranges cover suites, object blocks, groups, strings and Markdown executable blocks', () => {
    const source = `def render():

    # Keep comments with the suite.
    let data = object:
        'items': [
            1,
            2
        ]
    return data`;
    assert.deepEqual(foldingRanges(analysis(source)).map(range => [range.startLine, range.endLine]),
        [[0, 8], [3, 7], [4, 7]]);
    const text = "let text = '''first\nsecond\nthird'''\nsuccess text";
    assert.deepEqual(foldingRanges(analysis(text)), [{ startLine: 0, endLine: 2 }]);
    const markdown = markdownSource('```spl\nif True:\n    pass\n```\n\n> First\n> Second');
    assert.deepEqual(foldingRanges(markdownAnalysis(markdown)).map(range => [range.startLine, range.endLine]),
        [[5, 8], [6, 7], [10, 11]]);
    assert.deepEqual(foldingRanges(markdownAnalysis('# Normal\n\nText')), []);
});

function decodedTokens(source: string, result = analysis(source)) {
    const decoded: { text: string; type: string; modifiers: string[]; line: number; character: number }[] = [];
    const data = semanticTokens(result).data;
    let line = 0;
    let character = 0;
    for (let i = 0; i < data.length; i += 5) {
        line += data[i];
        character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
        const start = result.document.offsetAt({ line, character });
        decoded.push({
            text: source.slice(start, start + data[i + 2]), type: semanticTokenLegend.tokenTypes[data[i + 3]],
            modifiers: semanticTokenLegend.tokenModifiers.filter((_, bit) => data[i + 4] & (1 << bit)), line, character,
        });
    }
    return decoded;
}

test('semantic tokens classify lexical symbols with UTF-16 positions and declaration flags', () => {
    const source = `enum Color = 'red' | 'blue'
struct Data:
    color: Color
def render(value: str) -> str:
    return '😀 {value} {{value}}'
let data: Data = unknown
log($args, render('x'))`;
    const tokens = decodedTokens(source);
    assert.deepEqual(tokens.find(token => token.text === 'Color')?.modifiers, ['declaration']);
    assert.equal(tokens.find(token => token.text === 'Color')?.type, 'enum');
    assert.equal(tokens.find(token => token.text === 'Data')?.type, 'struct');
    assert.equal(tokens.find(token => token.text === 'color')?.type, 'property');
    const param = tokens.filter(token => token.text === 'value');
    assert.deepEqual(param.map(token => token.type), ['parameter', 'parameter']);
    assert.deepEqual(param.map(token => token.modifiers), [['declaration'], []]);
    assert.equal(param[1].character, at(source, 'value}', 0).character);
    assert.deepEqual(tokens.find(token => token.text === '$args')?.modifiers, ['readonly', 'defaultLibrary']);
    assert.equal(tokens.find(token => token.text === 'log')?.type, 'function');
    assert.ok(tokens.every(token => token.type !== undefined));
});

test('Markdown semantic tokens and workspace symbols remain gated and document-local', () => {
    const source = markdownSource('```spl\nlet total = 1\n```\n\n> Use @total.\n\nProse @total');
    const result = markdownAnalysis(source);
    assert.equal(decodedTokens(source, result).filter(token => token.text === 'total').length, 2);
    const plain = markdownAnalysis('# Plain\n\n```spl\nlet ignored = 1\n```');
    assert.deepEqual(semanticTokens(plain).data, []);
    const symbols = workspaceSymbols([result, plain, analysis('def TOTAL(value):\n    return value')], 'ToTaL');
    assert.deepEqual(symbols.map(symbol => symbol.name), ['total', 'TOTAL']);
    assert.deepEqual(symbols.map(symbol => symbol.location.uri), ['file:///workflow.md', uri]);
});

test('CRLF workflows keep navigation, diagnostics, semantic tokens and rename ranges in the document', () => {
    const source = '\uFEFF' + markdownSource('```spl\nlet value = 1\n```\n\n> Use @value.\n\n```spl\nask(bad=1) \'x\'\n```').replace(/\n/g, '\r\n');
    const result = markdownAnalysis(source);
    assert.deepEqual(result.diagnostics[0].range.start, at(source, 'bad'));
    assert.equal(references(result, at(source, 'value ='), true).length, 2);
    const tokens = decodedTokens(source, result);
    assert.equal(tokens.filter(token => token.text === 'value').length, 2);
    const change = rename(result, at(source, 'value ='), 'total').documentChanges?.[0];
    assert.ok(change && 'textDocument' in change);
    assert.ok(TextDocument.applyEdits(result.document, change.edits).includes('> Use @total.'));
});

for (const transport of ['stdio', 'ipc'] as const) {
    test(`LSP ${transport}: initialize, edits, features, close, and shutdown`, { timeout: 15000 }, async (t) => {
        const server = process.env.SPL_TEST_SERVER ?? path.resolve(__dirname, '..', 'server.cjs');
        const child = transport === 'ipc'
            ? fork(server, ['--node-ipc'], { silent: true, execArgv: [], cwd: path.dirname(server) })
            : spawn(process.execPath, [server, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: path.dirname(server) });
        assert.ok(child.stdin && child.stdout && child.stderr);
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        const connection = transport === 'ipc'
            ? createProtocolConnection(new IPCMessageReader(child), new IPCMessageWriter(child))
            : createProtocolConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
        t.after(() => {
            connection.dispose();
            if (child.exitCode === null) child.kill();
            assert.equal(stderr, '');
        });
        connection.listen();
        const nextDiagnostics = (): Promise<PublishDiagnosticsParams> => new Promise((resolve) => {
            const listener = connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
                listener.dispose();
                resolve(params);
            });
        });
        const initialized = await connection.sendRequest(InitializeRequest.type, {
            processId: process.pid, rootUri: null,
            capabilities: { workspace: { workspaceEdit: { documentChanges: transport === 'ipc' } } },
        });
        assert.equal(initialized.capabilities.textDocumentSync, TextDocumentSyncKind.Incremental);
        assert.equal(initialized.capabilities.definitionProvider, true);
        assert.equal(initialized.capabilities.referencesProvider, true);
        assert.deepEqual(initialized.capabilities.renameProvider, { prepareProvider: true });
        assert.equal(initialized.capabilities.foldingRangeProvider, true);
        assert.equal(initialized.capabilities.workspaceSymbolProvider, true);
        assert.ok(initialized.capabilities.semanticTokensProvider);
        assert.ok(initialized.capabilities.signatureHelpProvider);
        assert.ok(initialized.capabilities.completionProvider?.triggerCharacters?.includes('$'));
        assert.ok(initialized.capabilities.completionProvider?.triggerCharacters?.includes('('));
        assert.ok(initialized.capabilities.completionProvider?.triggerCharacters?.includes('.'));
        await connection.sendNotification(InitializedNotification.type, {});
        const initialDiagnostics = nextDiagnostics();
        await connection.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: { uri, languageId: 'spl', version: 1, text: 'let value =' },
        });
        assert.equal((await initialDiagnostics).diagnostics.length, 1);
        const cleanDiagnostics = nextDiagnostics();
        await connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version: 2 },
            contentChanges: [{ range: { start: { line: 0, character: 11 }, end: { line: 0, character: 11 } }, text: ' 1\nsuccess value' }],
        });
        const clean = await cleanDiagnostics;
        assert.equal(clean.version, 2);
        assert.deepEqual(clean.diagnostics, []);
        const params = { textDocument: { uri }, position: { line: 1, character: 9 } };
        const items = await connection.sendRequest(CompletionRequest.type, params);
        assert.ok(Array.isArray(items) && items.some((item) => item.label === 'value'));
        assert.ok(await connection.sendRequest(HoverRequest.type, params));
        const location = await connection.sendRequest(DefinitionRequest.type, params);
        assert.deepEqual(location, { uri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } } });
        const symbols = await connection.sendRequest(DocumentSymbolRequest.type, { textDocument: { uri } });
        assert.equal(symbols?.[0].name, 'value');
        const refs = await connection.sendRequest(ReferencesRequest.type, { ...params, context: { includeDeclaration: true } });
        assert.equal(refs?.length, 2);
        assert.equal((await connection.sendRequest(DocumentHighlightRequest.type, params))?.length, 2);
        assert.ok(await connection.sendRequest(PrepareRenameRequest.type, params));
        const edit = await connection.sendRequest(RenameRequest.type, { ...params, newName: 'total' });
        if (transport === 'ipc') {
            const change = edit?.documentChanges?.[0];
            assert.ok(change && 'textDocument' in change);
            assert.equal(change.textDocument.version, 2);
            assert.equal(change.edits.length, 2);
        } else {
            assert.equal(edit?.changes?.[uri].length, 2);
        }
        await assert.rejects(connection.sendRequest(RenameRequest.type, { ...params, newName: 'let' }), /identifier/);
        assert.ok((await connection.sendRequest(SemanticTokensRequest.type, { textDocument: { uri } }))?.data.length);
        assert.equal((await connection.sendRequest(WorkspaceSymbolRequest.type, { query: 'value' }))?.length, 1);
        assert.deepEqual(await connection.sendRequest(FoldingRangeRequest.type, { textDocument: { uri } }), []);
        const signatureDiagnostics = nextDiagnostics();
        await connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version: 3 },
            contentChanges: [{ text: 'def render(value):\n    return value\nrender(1)' }],
        });
        assert.deepEqual((await signatureDiagnostics).diagnostics, []);
        const signature = await connection.sendRequest(SignatureHelpRequest.type, {
            textDocument: { uri }, position: { line: 2, character: 8 },
        });
        assert.equal(signature?.signatures[0].label, 'def render(value)');
        assert.deepEqual(await connection.sendRequest(FoldingRangeRequest.type, { textDocument: { uri } }),
            [{ startLine: 0, endLine: 1 }]);
        const memberDiagnostics = nextDiagnostics();
        const memberSource = 'struct Data:\n    total: int\nlet value = unknown()\nif isinstance(value, Data):\n    value.';
        await connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version: 4 },
            contentChanges: [{ text: memberSource }],
        });
        assert.equal((await memberDiagnostics).diagnostics.length, 1);
        const members = await connection.sendRequest(CompletionRequest.type, {
            textDocument: { uri }, position: after(memberSource, 'value.'),
        });
        assert.ok(Array.isArray(members));
        assert.deepEqual(members.map(item => item.label), ['total']);
        const closedDiagnostics = nextDiagnostics();
        await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
        assert.deepEqual((await closedDiagnostics).diagnostics, []);
        assert.deepEqual(await connection.sendRequest(CompletionRequest.type, params), []);
        assert.deepEqual(await connection.sendRequest(ReferencesRequest.type, { ...params, context: { includeDeclaration: true } }), []);
        assert.deepEqual(await connection.sendRequest(SemanticTokensRequest.type, { textDocument: { uri } }), { data: [] });
        assert.deepEqual(await connection.sendRequest(WorkspaceSymbolRequest.type, { query: 'render' }), []);
        await connection.sendRequest(ShutdownRequest.type);
        const exited = once(child, 'exit');
        await connection.sendNotification(ExitNotification.type);
        assert.equal((await exited)[0], 0);
    });
}
