import * as fs from 'node:fs';
import * as path from 'node:path';
import { marked } from 'marked';
import { afterEach, describe, expect, it } from 'vitest';
import { Failure } from '../src/errors.js';
import { markdown as exported } from '../src/index.js';
import * as markdown from '../src/markdown-lib.js';
import { Document, bold, code, document, escape, image, italic, link } from '../src/markdown-lib.js';
import { cleanTemp, exec, execMarkdown, fence, tempDir } from './helpers.js';

afterEach(cleanTemp);

const reason = (action: () => unknown): string => {
    try {
        action();
    } catch (error) {
        if (error instanceof Failure) return `${error.statusCode}: ${error.reason}`;
        throw error;
    }
    throw new Error('expected a failure');
};

describe('Markdown builder', () => {
    it('builds all common blocks with chaining and deterministic string serialization', () => {
        const doc = new Document();
        doc.heading('Report', 2).paragraph(`${bold('Ready')} and ${italic('waiting')}`);
        doc.bulletList(['first', 'second\ncontinued']);
        doc.orderedList(['nine', 'ten\ncontinued'], 9);
        doc.quote('quoted\n\nagain');
        doc.codeBlock('let x = 1', 'js');
        doc.table(['Name', 'Value'], [['Ada', 'one'], ['Lin', 'two']]);
        doc.thematicBreak().raw('<details>raw</details>');
        const text = doc.toString();
        expect(text).toBe([
            '## Report', '**Ready** and *waiting*', '- first\n- second\n  continued',
            '9. nine\n10. ten\n    continued', '> quoted\n> \n> again',
            '```js\nlet x = 1\n```', '| Name | Value |\n| --- | --- |\n| Ada | one |\n| Lin | two |',
            '---', '<details>raw</details>',
        ].join('\n\n') + '\n');
        expect(marked.lexer(text).filter(token => token.type !== 'space').map(token => token.type))
            .toEqual(['heading', 'paragraph', 'list', 'list', 'blockquote', 'code', 'table', 'hr', 'html']);
        expect(`${doc}`).toBe(text);
        expect(doc.blocks).toHaveLength(9);
    });

    it('defaults to a first-level heading, a list starting at one and an unlabelled code block', () => {
        expect(document().heading('Title').orderedList(['a', 'b']).codeBlock('x').orderedList(['zero'], 0).toString())
            .toBe('# Title\n\n1. a\n2. b\n\n```\nx\n```\n\n0. zero\n');
    });

    it('keeps documents independent and permits repeated serialization and further mutation', () => {
        const first = document();
        const second = document();
        const empty = first.toString();
        first.paragraph('one');
        const snapshot = first.toString();
        const repeated = first.toString();
        first.paragraph('two');
        expect([empty, snapshot, repeated, first.toString(), second.toString()]).toEqual(['', 'one\n', 'one\n', 'one\n\ntwo\n', '']);
        expect(first).toBeInstanceOf(Document);
        expect(first).not.toBe(second);
    });

    it('preserves raw indentation and code whitespace while normalizing line endings', () => {
        expect(document().raw('    indented\r\n\r\nraw  ').codeBlock('  leading\r\n\r\ntrailing  \r\n', '').toString())
            .toBe('    indented\n\nraw  \n\n```\n  leading\n\ntrailing  \n```\n');
        expect(document().raw('').bulletList([]).orderedList([], 1).paragraph('').toString()).toBe('');
        expect(document().codeBlock('', '').toString()).toBe('```\n```\n');
        expect(document().bulletList(['a\r\nb']).quote('c\rd').toString()).toBe('- a\n  b\n\n> c\n> d\n');
    });

    it('escapes literal text and builds links and images with encoded destinations', () => {
        const text = '[a] *b* <c> &amp; {d} \\ `e`';
        const url = 'https://example.test/a (b)>\\c?q=%20\n';
        const built = link('a]b', url);
        expect(built).toBe('[a\\]b](<https://example.test/a%20(b)%3E%5Cc?q=%20%0A>)');
        expect(image('a]b', url)).toBe(`!${built}`);
        expect(marked.parseInline(escape(text))).toBe('[a] *b* &lt;c&gt; &amp;amp; {d} \\ `e`');
        expect(marked.parseInline(built)).toContain('href="https://example.test/a%20(b)%3E%5Cc?q=%20%0A"');
        expect(escape('# 1. item - not_a_list | cell ~x~ !')).toBe('\\# 1\\. item \\- not\\_a\\_list \\| cell \\~x\\~ \\!');
    });

    it.each([
        ['a`b', '``a`b``'],
        ['`edge`', '`` `edge` ``'],
        ['  padded  ', '`   padded   `'],
        ['   ', '`   `'],
        ['line\r\nnext', '`line next`'],
    ])('safely serializes inline code %j', (text, expected) => {
        const result = code(text);
        expect(result).toBe(expected);
        expect(marked.lexer(result)[0]).toMatchObject({
            type: 'paragraph', tokens: [{ type: 'codespan', text: text.replace(/\r\n/g, '\n').replace(/\n/g, ' ') }],
        });
    });

    it('uses code fences longer than embedded backtick runs', () => {
        const content = '```\nembedded\n````\n';
        const text = document().codeBlock(content, 'text').toString();
        expect(text).toBe('`````text\n```\nembedded\n````\n`````\n');
        expect(marked.lexer(text)[0]).toMatchObject({ type: 'code', lang: 'text', text: content.slice(0, -1) });
    });

    it('escapes table pipes, preserves already escaped pipes and expands multiline cells', () => {
        const text = document().table(['Header'], [['a|b\\|c\\\\|d\r\nnext']]).toString();
        expect(text).toBe('| Header |\n| --- |\n| a\\|b\\|c\\\\\\|d<br>next |\n');
        expect(marked.lexer(text)[0]).toMatchObject({ type: 'table', header: [{ text: 'Header' }], rows: [[{ text: 'a|b|c\\\\|d<br>next' }]] });
        expect(document().table(['A', 'B'], []).toString()).toBe('| A | B |\n| --- | --- |\n');
    });

    it.each([
        [() => document().heading('bad', 0), 'Markdown heading level must be between 1 and 6'],
        [() => document().heading('bad', 7), 'Markdown heading level must be between 1 and 6'],
        [() => document().heading('bad', 1.5), 'Markdown heading level must be between 1 and 6'],
        [() => document().heading('bad', 'one' as never), 'Markdown heading level must be between 1 and 6'],
        [() => document().heading('bad\nheading', 1), 'Markdown inline text must not contain newlines'],
        [() => document().orderedList(['bad'], -1), 'Markdown ordered list numbers must have at most nine digits'],
        [() => document().orderedList(['bad'], 1_000_000_000), 'Markdown ordered list numbers must have at most nine digits'],
        [() => document().orderedList(['bad'], 1.5), 'Markdown ordered list numbers must have at most nine digits'],
        [() => document().table([], []), 'Markdown tables require at least one column'],
        [() => document().table(['a'], [['a', 'b']]), 'Markdown table row width must match the headers'],
        [() => document().codeBlock('x', 'bad\nlang'), 'Markdown inline text must not contain newlines'],
        [() => document().codeBlock('x', '`'), 'Markdown code block language must not contain backticks'],
        [() => code(''), 'Markdown inline code must not be empty'],
        [() => bold('bad\ntext'), 'Markdown inline text must not contain newlines'],
        [() => italic('bad\rtext'), 'Markdown inline text must not contain newlines'],
        [() => link('bad\nlabel', 'https://example.test'), 'Markdown inline text must not contain newlines'],
    ])('reports invalid input explicitly %#', (action, message) => {
        expect(reason(action)).toBe(`assertion_failed: ${message}`);
    });

    it('leaves a document unchanged after failed appends', () => {
        const doc = document().paragraph('kept');
        expect(() => doc.table(['a'], [['valid'], ['invalid', 'width']])).toThrow(Failure);
        expect(() => doc.heading('bad', 9)).toThrow(Failure);
        expect(doc.toString()).toBe('kept\n');
    });

    it('is exported from the package as the markdown namespace', () => {
        expect(exported).toBe(markdown);
        expect(Object.keys(exported).sort()).toEqual(['Document', 'bold', 'code', 'document', 'escape', 'image', 'italic', 'link']);
    });
});

describe('Markdown builder in workflows', () => {
    it('is the global markdown of every fence and writes reports through restricted tools', async () => {
        const cwd = tempDir();
        const result = await execMarkdown(`${fence("const card = { term: 'closures', definition: 'Functions that remember' };")}

${fence(`const doc = markdown.document().heading(card.term, 3).paragraph(markdown.bold(card.definition));
doc.bulletList([markdown.code('x => x'), markdown.link('MDN', 'https://developer.mozilla.org')]);
await restrict('./out', () => writeFile('./out/card.md', doc.toString()));
success([doc instanceof markdown.Document, new markdown.Document().toString(), \`\${doc}\`]);`)}`, { cwd });
        const text = '### closures\n\n**Functions that remember**\n\n- `x => x`\n- [MDN](<https://developer.mozilla.org>)\n';
        expect(result).toEqual({ status: 'success', value: [true, '', text], hasValue: true });
        expect(fs.readFileSync(path.join(cwd, 'out', 'card.md'), 'utf8')).toBe(text);
    });

    it.each(['code', 'document'])('imports named bindings and namespaces from spl-lang/markdown in %s, ignoring local packages', async kind => {
        const cwd = tempDir();
        const local = path.join(cwd, 'node_modules', 'spl-lang');
        fs.mkdirSync(local, { recursive: true });
        fs.writeFileSync(path.join(local, 'package.json'), '{"name":"spl-lang","type":"module","exports":{"./markdown":"./markdown.js"}}');
        fs.writeFileSync(path.join(local, 'markdown.js'), "throw new Error('local packages must not shadow the library');");
        const source = `import { Document, bold as strong } from 'spl-lang/markdown';
import * as md from 'spl-lang/markdown';
const doc = new Document();
doc.heading('Report', 1);
for (const name of ['Ada', 'Lin']) doc.paragraph(strong(name));
success([doc.toString(), md.Document === Document, md.document() instanceof Document]);`;
        expect(await (kind === 'code' ? exec(source, { cwd }) : execMarkdown(fence(source), { cwd })))
            .toMatchObject({ status: 'success', value: ['# Report\n\n**Ada**\n\n**Lin**\n', true, true] });
    });

    it('shares the module identity with imports in nested helper modules', async () => {
        const cwd = tempDir();
        fs.mkdirSync(path.join(cwd, 'lib'));
        fs.writeFileSync(path.join(cwd, 'lib', 'report.mjs'), `import { Document } from 'spl-lang/markdown';
export const report = () => new Document().paragraph('Nested');`);
        expect(await execMarkdown(fence(`import { report } from './lib/report.mjs';
import { Document } from 'spl-lang/markdown';
const doc = report();
success([doc instanceof Document, doc.toString()]);`), { cwd })).toMatchObject({ status: 'success', value: [true, 'Nested\n'] });
    });

    it('fails the workflow with the line of an invalid call, unless caught', async () => {
        expect(await exec("const doc = markdown.document();\ndoc.heading('bad', 7);")).toMatchObject({
            status: 'failure', failure: {
                status_code: 'assertion_failed', reason: 'Markdown heading level must be between 1 and 6', line: 2, command: "doc.heading('bad', 7);",
            },
        });
        expect(await exec(`
const doc = markdown.document().paragraph('kept');
let caught;
try { doc.table(['a'], [['valid'], ['invalid', 'width']]); } catch (error) { caught = error instanceof Failure && error.statusCode; }
success([caught, doc.toString()]);`)).toMatchObject({ status: 'success', value: ['assertion_failed', 'kept\n'] });
    });

    it('rejects invalid arguments before a later model call', async () => {
        expect(await exec("markdown.document().heading('bad', 'one');\nawait ask('must not run');")).toMatchObject({
            status: 'failure', failure: { status_code: 'assertion_failed', line: 1 },
        });
    });

    it('lets a workflow shadow the global with its own binding', async () => {
        expect(await exec("const markdown = '# mine';\nsuccess(markdown);")).toMatchObject({ status: 'success', value: '# mine' });
    });
});
