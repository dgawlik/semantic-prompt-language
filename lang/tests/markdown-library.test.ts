import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { marked } from 'marked';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { parseMarkdown } from '../src/markdown.js';
import { isModuleSources, linkModules, readModuleSources } from '../src/modules.js';
import { parse } from '../src/parser.js';
import { Pin } from '../src/pin.js';
import { NoLlm } from './helpers.js';

vi.mock('node:fs', { spy: true });

let cwd: string;
const logger = new Logger('silent');
const literal = (text: string) => JSON.stringify(text).replaceAll('{', '{{').replaceAll('}', '}}');
const workflow = (source: string) =>
    `---\nextension: semantic-prompt-language\nversion: 1\n---\n\n\`\`\`\`spl\n${source}\n\`\`\`\`\n`;
const execute = (source: string, markdown = false) => run(
    markdown ? parseMarkdown(workflow(source)) : parse(source),
    { backend: new NoLlm(), logger, cwd, source: path.join(cwd, markdown ? 'main.md' : 'main.spl') },
);
async function output(source: string): Promise<string> {
    const result = await execute(`import * as markdown from 'markdown'\n${source}`);
    expect(result).toMatchObject({ status: 'success', value: expect.any(String) });
    if (result.status !== 'success' || typeof result.value !== 'string') throw new Error('expected Markdown output');
    return result.value;
}

beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-markdown-')); });
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
});

describe('SPL Markdown standard library', () => {
    it.each([false, true])('imports named bindings and namespaces from arbitrary SPL/Markdown locations (%s)', async markdown => {
        fs.writeFileSync(path.join(cwd, 'markdown.spl'), "fail 'local files must not shadow the standard library'");
        expect(await execute(`import { Document, bold as strong } from 'markdown'
import * as markdown from 'markdown'
let doc: Document = markdown.Document()
doc.heading('Report', 1)
for name in ['Ada', 'Lin']:
    doc.paragraph(strong(name))
success doc.to_string()`, markdown)).toMatchObject({
            status: 'success', value: '# Report\n\n**Ada**\n\n**Lin**\n',
        });
    });

    it('shares the standard module identity with imports in nested SPL modules', async () => {
        fs.mkdirSync(path.join(cwd, 'lib'));
        fs.writeFileSync(path.join(cwd, 'lib', 'report.spl'), `import { Document } from 'markdown'
def report() -> Document:
    return Document().paragraph('Nested')`);
        expect(await execute(`import { report } from './lib/report.spl'
import { Document } from 'markdown'
let doc: Document = report()
success doc.to_string()`, true)).toMatchObject({ status: 'success', value: 'Nested\n' });
    });

    it('builds all common blocks with chaining and deterministic string serialization', async () => {
        const text = await output(`let doc = markdown.Document()
doc.heading('Report', 2).paragraph(markdown.bold('Ready') + ' and ' + markdown.italic('waiting'))
doc.bullet_list(['first', 'second\\ncontinued'])
doc.ordered_list(['nine', 'ten\\ncontinued'], 9)
doc.quote('quoted\\n\\nagain')
doc.code_block('let x = 1', 'spl')
doc.table(['Name', 'Value'], [['Ada', 'one'], ['Lin', 'two']])
doc.thematic_break().raw('<details>raw</details>')
success doc.to_string()`);
        expect(text).toBe([
            '## Report', '**Ready** and *waiting*', '- first\n- second\n  continued',
            '9. nine\n10. ten\n    continued', '> quoted\n> \n> again',
            '```spl\nlet x = 1\n```', '| Name | Value |\n| --- | --- |\n| Ada | one |\n| Lin | two |',
            '---', '<details>raw</details>',
        ].join('\n\n') + '\n');
        expect(marked.lexer(text).filter(token => token.type !== 'space').map(token => token.type))
            .toEqual(['heading', 'paragraph', 'list', 'list', 'blockquote', 'code', 'table', 'hr', 'html']);
    });

    it('keeps documents independent and permits repeated serialization and further mutation', async () => {
        expect(await execute(`import { Document } from 'markdown'
let first = Document()
let second = Document()
let empty = first.to_string()
first.paragraph('one')
let snapshot = first.to_string()
let repeated = first.to_string()
first.paragraph('two')
success [empty, snapshot, repeated, first.to_string(), second.to_string()]`))
            .toMatchObject({ status: 'success', value: ['', 'one\n', 'one\n', 'one\n\ntwo\n', ''] });
    });

    it('preserves raw indentation and code whitespace while normalizing line endings', async () => {
        const raw = '    indented\r\n\r\nraw  ';
        const code = '  leading\r\n\r\ntrailing  \r\n';
        expect(await output(`success markdown.Document().raw(${literal(raw)}).code_block(${literal(code)}, '').to_string()`))
            .toBe('    indented\n\nraw  \n\n```\n  leading\n\ntrailing  \n```\n');
        expect(await output("success markdown.Document().raw('').bullet_list([]).ordered_list([], 1).to_string()")).toBe('');
        expect(await output("success markdown.Document().code_block('', '').to_string()")).toBe('```\n```\n');
    });

    it('escapes literal text and builds links and images with encoded destinations', async () => {
        const text = '[a] *b* <c> &amp; {d} \\ `e`';
        const url = 'https://example.test/a (b)>\\c?q=%20\n';
        const link = await output(`success markdown.link('a]b', ${literal(url)})`);
        expect(link).toBe('[a\\]b](<https://example.test/a%20(b)%3E%5Cc?q=%20%0A>)');
        expect(await output(`success markdown.image('a]b', ${literal(url)})`)).toBe('!' + link);
        const escaped = await output(`success markdown.escape(${literal(text)})`);
        expect(marked.parseInline(escaped)).toBe('[a] *b* &lt;c&gt; &amp;amp; {d} \\ `e`');
        expect(marked.parseInline(link)).toContain('href="https://example.test/a%20(b)%3E%5Cc?q=%20%0A"');
    });

    it.each([
        ['a`b', '``a`b``'],
        ['`edge`', '`` `edge` ``'],
        ['  padded  ', '`   padded   `'],
        ['   ', '`   `'],
        ['line\r\nnext', '`line next`'],
    ])('safely serializes inline code %j', async (text, expected) => {
        const result = await output(`success markdown.code(${literal(text)})`);
        expect(result).toBe(expected);
        expect(marked.lexer(result)[0]).toMatchObject({
            type: 'paragraph', tokens: [{ type: 'codespan', text: text.replace(/\r\n/g, '\n').replace(/\n/g, ' ') }],
        });
    });

    it('uses code fences longer than embedded backtick runs', async () => {
        const content = '```\nembedded\n````\n';
        const text = await output(`success markdown.Document().code_block(${literal(content)}, 'text').to_string()`);
        expect(text).toBe('`````text\n```\nembedded\n````\n`````\n');
        expect(marked.lexer(text)[0]).toMatchObject({ type: 'code', lang: 'text', text: content.slice(0, -1) });
    });

    it('escapes table pipes, preserves already escaped pipes and expands multiline cells', async () => {
        const cell = 'a|b\\|c\\\\|d\r\nnext';
        const text = await output(`success markdown.Document().table(['Header'], [[${literal(cell)}]]).to_string()`);
        expect(text).toBe('| Header |\n| --- |\n| a\\|b\\|c\\\\\\|d<br>next |\n');
        const tokens = marked.lexer(text);
        expect(tokens[0]).toMatchObject({ type: 'table', header: [{ text: 'Header' }], rows: [[{ text: 'a|b|c\\\\|d<br>next' }]] });
    });

    it.each([
        ["markdown.Document().heading('bad', 0)", 'heading level'],
        ["markdown.Document().heading('bad', 7)", 'heading level'],
        ["markdown.Document().heading('bad\\nheading', 1)", 'newlines'],
        ["markdown.Document().ordered_list(['bad'], -1)", 'nine digits'],
        ["markdown.Document().ordered_list(['bad'], 1000000000)", 'nine digits'],
        ["markdown.Document().table([], [])", 'at least one column'],
        ["markdown.Document().table(['a'], [['a', 'b']])", 'row width'],
        ["markdown.Document().code_block('x', 'bad\\nlang')", 'newlines'],
        [`markdown.Document().code_block('x', ${literal('`')})`, 'backticks'],
        ["markdown.code('')", 'must not be empty'],
        ["markdown.bold('bad\\ntext')", 'newlines'],
    ])('reports invalid input explicitly: %s', async (expression, reason) => {
        expect(await execute(`import * as markdown from 'markdown'\n${expression}`)).toMatchObject({
            status: 'failure', failure: { reason: expect.stringContaining(reason) },
        });
    });

    it('rejects invalid typed arguments before a model call and leaves a document unchanged after failed appends', async () => {
        expect(await execute(`import { Document } from 'markdown'
let earlier = ask 'must not run'
Document().heading('bad', 'one')`)).toMatchObject({ status: 'failure', failure: { status_code: 'type_error' } });
        expect(await output(`let doc = markdown.Document().paragraph('kept')
try:
    doc.table(['a'], [['valid'], ['invalid', 'width']])
except error:
    pass
success doc.to_string()`)).toBe('kept\n');
    });

    it('records bundled SPL sources with portable identities and links without filesystem reads', () => {
        const program = parse("import { Document } from 'markdown'");
        const sources = readModuleSources(program, cwd);
        expect(sources.files).toHaveLength(1);
        expect(sources.files[0]).toMatchObject({ standard: 'markdown', source: expect.stringContaining('class Document:') });
        const moved = {
            ...sources,
            files: sources.files.map(file => ({
                ...file, path: path.join(cwd, 'other-install', 'markdown.spl'), id: path.join(cwd, 'other-install', 'markdown.spl'),
            })),
        };
        expect(isModuleSources(moved)).toBe(true);
        vi.mocked(fs.readFileSync).mockClear();
        expect(linkModules(program, moved).modules.size).toBe(1);
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it('replays a pinned document from recorded standard library source without rereading the library', async () => {
        const source = workflow("import { Document } from 'markdown'\nsuccess Document().heading('Pinned', 1).to_string()");
        const pin = Pin.capture(source, { cwd, args: [] });
        const options = { backend: new NoLlm(), logger, cwd };
        const first = await run(parseMarkdown(source), { ...options, pin });
        expect(first).toMatchObject({ status: 'success', value: '# Pinned\n' });
        const locked = pin.toMarkdown(source);
        vi.mocked(fs.readFileSync).mockClear();
        expect(await run(parseMarkdown(locked), options)).toEqual(first);
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });
});
