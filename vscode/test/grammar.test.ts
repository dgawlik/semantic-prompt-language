import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';
import { HEADER_KEYS, scan } from '../../lang/src/scanner.js';

const root = path.resolve(__dirname, '..', '..');
const examples = path.resolve(root, '..', 'lang', 'examples');
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

// Stand-ins for the grammars a `.spl` file embeds, with the scopes of the real ones. Like them, they have
// constructs that span lines: a block must not start inside one, and must end at its fence inside another.
const embedded: Record<string, object> = {
    'source.ts': {
        scopeName: 'source.ts',
        patterns: [
            { begin: '/\\*', end: '\\*/', name: 'comment.block.ts' },
            { match: '//.*$', name: 'comment.line.double-slash.ts' },
            { begin: '`', end: '`', name: 'string.template.ts', patterns: [{ match: '\\\\.' }] },
            { begin: "'", end: "'|$", name: 'string.quoted.single.ts', patterns: [{ match: '\\\\.' }] },
            { begin: '"', end: '"|$', name: 'string.quoted.double.ts', patterns: [{ match: '\\\\.' }] },
            { match: '(?:[=(,:!&|?]|^|\\breturn)\\s*(/(?:[^/\\\\\\[]|\\\\.|\\[(?:[^\\]\\\\]|\\\\.)*\\])+/[a-z]*)', captures: { 1: { name: 'string.regexp.ts' } } },
            { begin: '\\{', end: '\\}', name: 'meta.block.ts', patterns: [{ include: '$self' }] },
            { match: '\\b(?:const|let|await|async|function|return|import|from)\\b', name: 'keyword.ts' },
            { match: '[A-Za-z_$][\\w$]*', name: 'variable.other.readwrite.ts' },
        ],
        repository: {
            'function-parameters': {
                begin: '\\(', end: '\\)', name: 'meta.parameters.ts',
                patterns: [{ match: '\\b(?:string|number)\\b', name: 'support.type.primitive.ts' }, { match: '[A-Za-z_$][\\w$]*', name: 'variable.parameter.ts' }],
            },
            'return-type': { match: '(?<=\\))\\s*:.*', name: 'meta.return.type.ts' },
        },
    },
    'source.yaml': {
        scopeName: 'source.yaml',
        patterns: [
            { begin: '"', end: '"', name: 'string.quoted.double.yaml' },
            { begin: '\\{', end: '\\}', name: 'meta.flow.mapping.yaml' },
            { match: '\\b(?:true|false)\\b', name: 'constant.language.boolean.yaml' },
            { match: '[^\\s"{}]+', name: 'string.unquoted.plain.out.yaml' },
        ],
    },
    'text.html.markdown': {
        scopeName: 'text.html.markdown',
        patterns: [
            { match: '^#+ .*$', name: 'markup.heading.markdown' },
            { begin: '^```', end: '^```', name: 'markup.fenced_code.block.markdown' },
            { match: '^---$', name: 'meta.separator.markdown' },
        ],
    },
};

const BLOCK = 'meta.block.spl';
const FENCE = /^keyword\.control\.block\.(?:begin|end)\.spl$/;
const KEY = 'entity.name.tag.header.spl';
const INSTRUCTION = 'string.unquoted.instruction.spl';
const REFERENCE = 'variable.other.reference.spl';
const OUTPUT = 'variable.other.constant.output.spl';
const FUNCTION = 'entity.name.function.spl';
const TYPESCRIPT = 'meta.embedded.inline.typescript';
const MARKDOWN = 'meta.embedded.block.markdown';
const COMMENT = 'comment.block.documentation.spl';

interface Token {
    text: string;
    start: number;
    end: number;
    scopes: string[];
}

const grammar = (async () => {
    const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
    await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    const registry = new vsctm.Registry({
        onigLib: Promise.resolve({
            createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
            createOnigString: text => new oniguruma.OnigString(text),
        }),
        loadGrammar: async scope => {
            if (Object.hasOwn(embedded, scope)) return embedded[scope] as vsctm.IRawGrammar;
            if (scope !== 'source.spl') return null;
            const file = path.join(root, 'syntaxes', 'spl.tmLanguage.json');
            return vsctm.parseRawGrammar(readFileSync(file, 'utf8'), file);
        },
    });
    return (await registry.loadGrammar('source.spl'))!;
})();

/** Tokenizes consecutive lines: each with its tokens and the depth of the constructs still open after it. */
async function tokenize(source: string): Promise<{ line: string; depth: number; tokens: Token[] }[]> {
    const loaded = await grammar;
    let stack = vsctm.INITIAL;
    return source.split('\n').map(line => {
        const result = loaded.tokenizeLine(line, stack);
        stack = result.ruleStack;
        return {
            line, depth: stack.depth,
            tokens: result.tokens.map(token => ({ text: line.slice(token.startIndex, token.endIndex), start: token.startIndex, end: token.endIndex, scopes: token.scopes })),
        };
    });
}
const scoped = (tokens: Token[], scope: string): string[] => tokens.filter(token => token.scopes.includes(scope)).map(token => token.text);
const has = (tokens: Token[], text: string, ...scopes: string[]): boolean =>
    tokens.some(token => token.text === text && scopes.every(scope => token.scopes.includes(scope)));
const all = (tokens: Token[], scope: string): boolean => tokens.every(token => token.scopes.includes(scope));
/** Tokens that belong to the extension's own syntax rather than to TypeScript. */
const own = (tokens: Token[]): Token[] => tokens.filter(token => token.scopes.slice(1).some(scope => scope.endsWith('.spl') || scope === MARKDOWN));
const fence = (tokens: Token[]): boolean => tokens.some(token => token.text === '---' && token.scopes.some(scope => FENCE.test(scope)));

test('the manifest contributes the .spl language, its grammar, snippets and the run commands, and nothing for Markdown', () => {
    const manifest = json('package.json');
    assert.equal(manifest.version, '3.0.0');
    assert.deepEqual(manifest.activationEvents, ['onLanguage:spl']);
    const { contributes } = manifest;
    assert.deepEqual(Object.keys(contributes).sort(), ['commands', 'configuration', 'grammars', 'languages', 'menus', 'snippets']);
    assert.deepEqual(contributes.languages.map((language: { id: string; extensions: string[] }) => [language.id, language.extensions]), [['spl', ['.spl']]]);
    assert.deepEqual(contributes.grammars, [{
        language: 'spl', scopeName: 'source.spl', path: './syntaxes/spl.tmLanguage.json', embeddedLanguages: { [MARKDOWN]: 'markdown' },
    }]);
    assert.deepEqual(readdirSync(path.join(root, 'syntaxes')), ['spl.tmLanguage.json']);
    assert.deepEqual(contributes.snippets, [{ language: 'spl', path: './snippets/spl.code-snippets' }]);

    const commands: string[] = contributes.commands.map((command: { command: string }) => command.command);
    assert.deepEqual(commands, ['spl.run', 'spl.debug']);
    assert.deepEqual(contributes.commands.map((command: { title: string }) => command.title), ['SPL: Run Workflow', 'SPL: Debug Workflow']);
    for (const menu of ['commandPalette', 'editor/title/run', 'editor/context', 'explorer/context']) {
        const entries: { command: string; when: string }[] = contributes.menus[menu];
        assert.deepEqual(entries.map(entry => entry.command), commands, menu);
        assert.ok(entries.every(entry => /^(?:editor|resource)LangId == spl$/.test(entry.when)), `${menu} is limited to .spl files`);
    }
    assert.deepEqual(Object.keys(contributes.configuration.properties), ['spl.executablePath']);
    assert.equal(contributes.configuration.properties['spl.executablePath'].default, 'spl');
    assert.doesNotMatch(JSON.stringify(manifest), /notebook|markdown\.tmLanguage|onLanguage:markdown|openai|anthropic|genai/i);

    const configuration = json(manifest.contributes.languages[0].configuration);
    assert.deepEqual(configuration.comments, { lineComment: '//', blockComment: ['/*', '*/'] });
    assert.deepEqual(configuration.brackets, [['{', '}'], ['[', ']'], ['(', ')']]);
    for (const pair of ['{', '[', '(', "'", '"', '`']) assert.ok(configuration.autoClosingPairs.some((item: { open: string }) => item.open === pair), pair);
});

test('the snippets are valid .spl: each block scans without problems', () => {
    const snippets: Record<string, { prefix: string; body: string[] }> = json('snippets/spl.code-snippets');
    const code = ['decision', 'decision-labels'];
    assert.deepEqual(Object.values(snippets).map(snippet => snippet.prefix).sort(), ['agent', 'ask', 'codegen', ...code, 'defaults', 'doc']);
    for (const [name, snippet] of Object.entries(snippets)) {
        const text = snippet.body.join('\n').replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '');
        const scanned = scan(text);
        assert.deepEqual(scanned.problems, [], name);
        const parts = scanned.blocks.length + scanned.comments.length + (scanned.defaults ? 1 : 0);
        assert.equal(parts, code.includes(snippet.prefix) ? 0 : 1, name);
    }
});

test('the grammar knows exactly the header keys of the scanner', () => {
    const { repository } = json('syntaxes/spl.tmLanguage.json');
    const keys = [/\((mode\|[^)]*)\)/.exec(repository.header.begin)![1].split('|'), /\((\w+)\)/.exec(repository['output-type'].match)![1]].flat();
    assert.deepEqual(keys.sort(), HEADER_KEYS.map(key => key.name).sort());
});

test('a Markdown comment is Markdown between its markers', async () => {
    const lines = await tokenize('const a = 1;\n//*\n# Title\n\n---\nmode: agent\n```\n*//\nconst b = `x`;\n  //* indented, with text\n  *// trailing\n//*not a comment');
    assert.ok(has(lines[1].tokens, '//*', COMMENT, 'punctuation.definition.comment.begin.spl'));
    assert.ok(has(lines[2].tokens, '# Title', MARKDOWN, 'markup.heading.markdown'));
    for (const index of [3, 4, 5, 6]) assert.ok(all(lines[index].tokens, MARKDOWN), lines[index].line);
    assert.ok(has(lines[4].tokens, '---', 'meta.separator.markdown') && !fence(lines[4].tokens), 'a rule inside a comment is not a fence');
    assert.deepEqual(scoped(lines[5].tokens, KEY), []);
    assert.ok(has(lines[7].tokens, '*//', COMMENT, 'punctuation.definition.comment.end.spl'), 'the comment ends inside an open code fence');
    assert.equal(lines[7].depth, 1);
    assert.ok(has(lines[8].tokens, 'const', 'keyword.ts') && own(lines[8].tokens).length === 0, 'code follows');
    assert.ok(has(lines[9].tokens, '//*', COMMENT) && has(lines[9].tokens, ' indented, with text', MARKDOWN));
    assert.ok(has(lines[10].tokens, '*//', COMMENT));
    assert.ok(has(lines[11].tokens, '//*not a comment', 'comment.line.double-slash.ts'), 'the marker needs a space or the end of the line');
});

test('a block has a YAML header with known keys and an instruction', async () => {
    const lines = await tokenize([
        '---', 'model: gpt-6-luna', 'enforce:', '  - Answer briefly', '  - "Stay polite"', 'hide: true', 'restrict: { fs: ./src }',
        'outputVar: joke', 'outputType: List(Joke)', '', 'A joke about cats.', 'model: not a key any more', '---', 'const after = 1;',
    ].join('\n'));
    assert.ok(fence(lines[0].tokens) && fence(lines[12].tokens));
    for (const line of lines.slice(0, 13)) assert.ok(all(line.tokens, BLOCK), line.line);
    assert.deepEqual(lines.slice(1, 9).flatMap(line => scoped(line.tokens, KEY)), ['model', 'enforce', 'hide', 'restrict', 'outputVar', 'outputType']);
    assert.ok(has(lines[1].tokens, ':', 'punctuation.separator.key-value.spl') && has(lines[1].tokens, 'gpt-6-luna', 'string.unquoted.plain.out.yaml'));
    assert.ok(has(lines[3].tokens, 'Answer', 'meta.header.spl', 'string.unquoted.plain.out.yaml'), 'indented lines continue a YAML value');
    assert.equal(scoped(lines[4].tokens, 'string.quoted.double.yaml').join(''), '"Stay polite"');
    assert.ok(has(lines[5].tokens, 'true', 'constant.language.boolean.yaml'));
    assert.equal(scoped(lines[6].tokens, 'meta.flow.mapping.yaml').join(''), '{ fs: ./src }');
    assert.ok(has(lines[8].tokens, 'List', TYPESCRIPT, 'variable.other.readwrite.ts') && has(lines[8].tokens, 'Joke', TYPESCRIPT), 'outputType is TypeScript');
    assert.deepEqual(scoped(lines[8].tokens, 'string.unquoted.plain.out.yaml'), []);
    assert.ok(has(lines[10].tokens, 'A joke about cats.', INSTRUCTION));
    assert.ok(has(lines[11].tokens, 'model: not a key any more', INSTRUCTION), 'the header ends at the first line that is not a key');
    assert.equal(lines[12].depth, 1);
    assert.ok(own(lines[13].tokens).length === 0 && has(lines[13].tokens, 'after', 'variable.other.readwrite.ts'));

    const unknown = await tokenize('---\nmode: agent\ntitle: not a key\nmodel: x\n---');
    assert.deepEqual(unknown.flatMap(line => scoped(line.tokens, KEY)), ['mode'], 'an unknown key starts the instruction');
    assert.ok(all(unknown[3].tokens, INSTRUCTION));
    // A lone word after the header may become a key: it stays code-like so that suggestions appear while typing.
    const typing = await tokenize('---\nmode: agent\nrest\n---');
    assert.ok(has(typing[2].tokens, 'rest', 'meta.embedded.inline.header.spl') && !all(typing[2].tokens, INSTRUCTION));
    assert.equal(typing[3].depth, 1);
});

test('references, escapes, outputs and generated functions stand out in the instruction', async () => {
    const instruction = 'Call @fib with @invoice.total, mail user@example.com, write @@literal and @=x ->[List(Union(Str, Int))] @tags, ->@plain -> [Int] @=count -> nothing';
    const [line] = (await tokenize(`---\nmode: agent\n\n${instruction}\n---`)).slice(3);
    assert.deepEqual(scoped(line.tokens, REFERENCE).join(''), '@fib@invoice.total');
    assert.ok(line.tokens.filter(token => token.scopes.includes(REFERENCE)).every(token => token.scopes.includes('meta.embedded.inline.reference.spl')),
        'references are not part of the surrounding string');
    assert.ok(has(line.tokens, '@@', 'constant.character.escape.spl'));
    assert.deepEqual(scoped(line.tokens, OUTPUT), ['tags', 'plain', 'count']);
    assert.deepEqual(scoped(line.tokens, 'keyword.operator.arrow.spl'), ['->', '->', '->'], 'an arrow without an output is text');
    assert.ok(has(line.tokens, '=', 'keyword.operator.assignment.spl'));
    assert.deepEqual(scoped(line.tokens, TYPESCRIPT).join(''), 'List(Union(Str, Int))Int');
    assert.ok(has(line.tokens, 'Union', TYPESCRIPT, 'variable.other.readwrite.ts'), 'the type expression is TypeScript');
    assert.ok(has(line.tokens, ', mail user@example.com, write ', INSTRUCTION) && has(line.tokens, ' -> nothing', INSTRUCTION));

    const [signature, bare] = (await tokenize('---\nmode: codegen\n\nSlug of a title -> @slugify(text: string, width?: number): string\nand -> @helper\n---')).slice(3);
    assert.deepEqual(scoped(signature.tokens, FUNCTION), ['slugify']);
    assert.deepEqual(scoped(signature.tokens, 'support.type.primitive.ts'), ['string', 'number']);
    assert.ok(has(signature.tokens, ': string', TYPESCRIPT, 'meta.return.type.ts'));
    assert.deepEqual(scoped(bare.tokens, OUTPUT), ['helper']);
});

test('fences and comment markers inside strings, templates and comments are not syntax; blocks nest in code', async () => {
    const lines = await tokenize([
        'const text = `', '---', 'mode: agent', '//*', '# Title', '`;',
        '/*', '---', '//*', '*/',
        "const dashes = '---';", 'const minus = a --- b;', '// ---',
        'async function work() {', '    ---', '    mode: agent', '', '    Use @notes -> @result', '    ---', '    return result;', '}',
    ].join('\n'));
    for (const index of [1, 2, 3, 4]) assert.ok(all(lines[index].tokens, 'string.template.ts') && own(lines[index].tokens).length === 0, lines[index].line);
    for (const index of [7, 8]) assert.ok(all(lines[index].tokens, 'comment.block.ts') && own(lines[index].tokens).length === 0, lines[index].line);
    for (const index of [10, 11, 12]) assert.equal(own(lines[index].tokens).length, 0, lines[index].line);
    assert.ok(fence(lines[14].tokens) && has(lines[14].tokens, '---', 'meta.block.ts'), 'a block inside a function body');
    assert.deepEqual(scoped(lines[15].tokens, KEY), ['mode']);
    assert.deepEqual([scoped(lines[17].tokens, REFERENCE).join(''), scoped(lines[17].tokens, OUTPUT)], ['@notes', ['result']]);
    assert.ok(fence(lines[18].tokens));
    assert.ok(has(lines[19].tokens, 'return', 'keyword.ts', 'meta.block.ts') && own(lines[19].tokens).length === 0);
    assert.equal(lines[20].depth, 1);
});

test('a block ends at its closing fence inside constructs the embedded grammars have not finished', async () => {
    for (const unfinished of ['restrict: { fs: ./src', 'model: "unfinished', 'outputType: List(`x', 'outputVar: x\n\nUse `ticks ${ and ->[List(] @x', 'outputVar: x\n\n//* text']) {
        const lines = await tokenize(`---\n${unfinished}\n---\nconst after = 1;\n---\noutputVar: y\n\nUse @notes\n---`);
        const end = lines.findIndex((line, index) => index > 0 && fence(line.tokens));
        assert.equal(end, unfinished.split('\n').length + 1, unfinished);
        assert.equal(lines[end].depth, 1, unfinished);
        assert.ok(has(lines[end + 1].tokens, 'const', 'keyword.ts') && own(lines[end + 1].tokens).length === 0, unfinished);
        assert.deepEqual(scoped(lines.at(-2)!.tokens, REFERENCE).join(''), '@notes', unfinished);
        assert.equal(lines.at(-1)!.depth, 1, unfinished);
    }
});

test('every example is colored the way the scanner reads it', async () => {
    const files = readdirSync(examples, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.spl')).sort();
    assert.ok(files.length > 20 && existsSync(path.join(examples, 'hi.spl')), `examples found in ${examples}`);
    let references = 0;
    let outputs = 0;
    for (const file of files) {
        const scanned = scan(readFileSync(path.join(examples, file), 'utf8'));
        assert.deepEqual(scanned.problems, [], file);
        const lines = await tokenize(scanned.lines.join('\n'));
        const inside = (ranges: { line: number; endLine: number }[], index: number) => ranges.some(range => index + 1 >= range.line && index + 1 <= range.endLine);
        const blocks = [...scanned.blocks, ...(scanned.defaults ? [scanned.defaults] : [])];
        const token = (line: number, column: number): Token => lines[line - 1].tokens.find(item => item.start <= column - 1 && column - 1 < item.end)!;
        lines.forEach(({ tokens, line }, index) => {
            const at = `${file}:${index + 1}: ${line}`;
            assert.equal(all(tokens, BLOCK), inside(blocks, index), at);
            assert.equal(tokens.some(item => item.scopes.includes(MARKDOWN) || item.scopes.includes(COMMENT)), inside(scanned.comments, index), at);
            if (!inside(blocks, index) && !inside(scanned.comments, index)) assert.equal(own(tokens).length, 0, at);
            assert.equal(fence(tokens), blocks.some(block => block.line === index + 1 || block.endLine === index + 1), at);
            assert.ok(tokens.every(item => !item.scopes.some(scope => scope.startsWith('invalid'))), at);
        });
        for (const block of scanned.blocks) {
            for (const input of block.inputs) {
                assert.ok(token(input.line, input.column).scopes.includes(REFERENCE), `${file}:${input.line}: @${input.name}`);
                references++;
            }
            for (const output of block.mode === 'ask' ? [] : block.outputs) {
                assert.ok(token(output.line, output.column).scopes.includes(block.mode === 'codegen' && output.type ? FUNCTION : OUTPUT), `${file}:${output.line}: @${output.name}`);
                outputs++;
            }
            const first = lines[block.line].tokens;
            if (/^\s*\w+:/.test(lines[block.line].line)) assert.equal(scoped(first, KEY).length, 1, `${file}:${block.line + 1}: header key`);
        }
        assert.equal(lines.at(-1)!.depth, 1, file);
    }
    assert.ok(references > 20 && outputs > 10, `${references} references and ${outputs} outputs checked`);
});
