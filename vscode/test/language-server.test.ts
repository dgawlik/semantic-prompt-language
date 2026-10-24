import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
    createProtocolConnection, IPCMessageReader, IPCMessageWriter, StreamMessageReader, StreamMessageWriter,
    CompletionRequest, DefinitionRequest, DocumentSymbolRequest, ExitNotification, HoverRequest,
    InitializeRequest, InitializedNotification, ShutdownRequest,
    DidChangeTextDocumentNotification, DidCloseTextDocumentNotification, DidOpenTextDocumentNotification,
    PublishDiagnosticsNotification, SymbolKind, TextDocumentSyncKind,
    type PublishDiagnosticsParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze, completions, definition, documentSymbols, hover } from '../src/features';
import { builtins } from '../src/catalog';
import { makeBuiltins } from '../../lang/src/builtins.js';
import { MODIFIER_NAMES } from '../../lang/src/parser.js';

const root = path.resolve(__dirname, '..', '..');
const uri = 'file:///test.spl';
const document = (source: string) => TextDocument.create(uri, 'spl', 1, source);
const analysis = (source: string) => analyze(document(source));

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
    const files = readdirSync(examples).filter((file) => file.endsWith('.spl'));
    assert.ok(files.length > 0);
    for (const file of files) {
        assert.deepEqual(analysis(readFileSync(path.join(examples, file), 'utf8')).diagnostics, [], file);
    }
});

test('human input has keyword help and no model modifier completion', () => {
    const source = "let answer = human 'Review this draft'";
    assert.deepEqual(analysis(source).diagnostics, []);
    assert.match(JSON.stringify(hover(analysis(source), at(source, 'human'))?.contents), /Noninteractive human input/);
    assert.ok(completions(analysis(''), { line: 0, character: 0 }).some((item) => item.label === 'human'));
    const incomplete = 'human (';
    const items = completions(analysis(incomplete), document(incomplete).positionAt(incomplete.length));
    for (const name of MODIFIER_NAMES) assert.ok(!items.some((item) => item.label === name && item.textEdit?.newText === `${name}=`));
    assert.match(analysis("human(fmt='text') 'question'").diagnostics[0].message, /does not accept modifiers/);
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
    const runtimeNames = [...makeBuiltins({ log() {} }).keys(), 'read_file', 'write_file', 'web_fetch', 'web_search', 'shell'];
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
    assert.deepEqual(items.map((item) => item.label), [...MODIFIER_NAMES]);
    assert.deepEqual(items.find((item) => item.label === 'reasoning')?.textEdit, {
        range: { start: at(source, 'rea'), end: document(source).positionAt(source.indexOf('rea') + 3) },
        newText: 'reasoning=',
    });
    for (const call of ['ask', 'think', 'agent']) {
        const text = `let x = ${call}(`;
        assert.deepEqual(completions(analysis(text), document(text).positionAt(text.length)).map((item) => item.label), [...MODIFIER_NAMES]);
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
});

test('multiline modifiers preserve contexts through nested values and unfinished parentheses', () => {
    const source = `let result = ask(
    schema={'type': 'integer'},
    model=choose('one', 'two'),
    rea
) 'prompt'`;
    assert.deepEqual(
        completions(analysis(source), document(source).positionAt(source.indexOf('rea') + 3)).map((item) => item.label),
        [...MODIFIER_NAMES],
    );
    const incomplete = `let result = ask(
    fmt='integer',
    rep`;
    assert.deepEqual(
        completions(analysis(incomplete), document(incomplete).positionAt(incomplete.length)).map((item) => item.label),
        [...MODIFIER_NAMES],
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
        'def first(value) {',
        '    if True { let local = value }',
        '    return local + outer',
        '}',
        'def second(value) { return value }',
        'success outer',
    ].join('\n');
    const result = analysis(source);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(definition(result, at(source, 'local +')), undefined);
    assert.deepEqual(definition(result, at(source, 'outer', 1))?.range.start, at(source, 'outer'));
    assert.deepEqual(definition(result, at(source, 'value }'))?.range.start, at(source, 'value'));
    assert.deepEqual(definition(result, at(source, 'value }', 1))?.range.start, at(source, 'value', 2));
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
        '{ let x = 2; log(x) }',
        'log(x)',
        'for i in [1] { log(i) }',
        "try { fail 'x' } except err { log(err) }",
        'log(i, err)',
        'let value = if True { let hidden = 3; hidden } else { 0 }',
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

test('definitions handle nested functions, redeclarations, loop and exception bindings', () => {
    const source = [
        'let name = 1; let name = 2',
        'def outer(param) {',
        '    def inner() { return param + name }',
        '    return inner()',
        '}',
        'for i, item in enumerate([]) { log(i, item) }',
        "try { fail 'x' } except err { log(err.reason) }",
    ].join('\n');
    const result = analysis(source);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(definition(result, at(source, 'name }'))?.range.start, at(source, 'name', 1));
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

test('symbols include nested functions and block bindings with valid selection ranges', () => {
    const source = "let x = 1\ndef foo(param) {\n    if True { let nested = param }\n}\n{ let visible = 2 }";
    const symbols = documentSymbols(analysis(source));
    assert.deepEqual(symbols.map((symbol) => symbol.name), ['x', 'foo', 'visible']);
    const fn = symbols[1];
    assert.equal(fn.kind, SymbolKind.Function);
    assert.deepEqual(fn.children?.map((symbol) => symbol.name), ['nested']);
    assert.deepEqual(fn.selectionRange.start, at(source, 'foo'));
    assert.deepEqual(fn.range.end, { line: 3, character: 1 });
});

test('the language server never executes source', () => {
    const source = "let output = shell('must-not-run')\nwrite_file('must-not-exist', 'x')\nlet response = agent 'must-not-call-model'";
    assert.deepEqual(analysis(source).diagnostics, []);
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
            processId: process.pid, rootUri: null, capabilities: {},
        });
        assert.equal(initialized.capabilities.textDocumentSync, TextDocumentSyncKind.Incremental);
        assert.equal(initialized.capabilities.definitionProvider, true);
        assert.ok(initialized.capabilities.completionProvider?.triggerCharacters?.includes('$'));
        assert.ok(initialized.capabilities.completionProvider?.triggerCharacters?.includes('('));
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
        const closedDiagnostics = nextDiagnostics();
        await connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
        assert.deepEqual((await closedDiagnostics).diagnostics, []);
        assert.deepEqual(await connection.sendRequest(CompletionRequest.type, params), []);
        await connection.sendRequest(ShutdownRequest.type);
        const exited = once(child, 'exit');
        await connection.sendNotification(ExitNotification.type);
        assert.equal((await exited)[0], 0);
    });
}
