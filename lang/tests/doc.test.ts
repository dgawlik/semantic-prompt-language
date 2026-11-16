import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { check } from '../src/check.js';
import { documentHtml, documentMarkdown } from '../src/doc.js';
import { SplSyntaxError } from '../src/errors.js';
import { agentBlock, block, cleanTemp, tempDir } from './helpers.js';

afterEach(cleanTemp);

describe('spl doc', () => {
    const source = [
        '//*', '# Title', '', 'Intro with `code`.', '*//',
        '---', 'model: gpt-6-luna', 'enforce: [Be brief, Be kind]', '---',
        "import * as fs from 'node:fs';", '', '// An ordinary comment stays with the code.', 'const topic = "x";', '',
        block('Explain @topic\nin two lines.\n\n- as a list\n- of points', 'outputVar: answer', 'outputType: List(Str)', 'repairs: 2'),
        '//*', '## Next', '*//',
        'async function nested() {', '    ---', '    mode: agent', '', '    Do it -> @x', '    ---', '    return x;', '}',
        agentBlock('Call @nested ->[Int] @n', 'restrict: { fs: ./out }'),
        'success(n);',
    ].join('\n');

    it('turns comments into prose, code runs into ts fences and top-level blocks into callouts', () => {
        expect(documentMarkdown(source)).toBe([
            '# Title', '', 'Intro with `code`.', '',
            '> **file defaults**', '>', '> | Setting | Value |', '> | --- | --- |', '> | `model` | `gpt-6-luna` |', '> | `enforce` | `Be brief`, `Be kind` |', '',
            '```ts', "import * as fs from 'node:fs';", '', '// An ordinary comment stays with the code.', 'const topic = "x";', '```', '',
            '> **ask block**', '>', '> | Setting | Value |', '> | --- | --- |', '> | `outputVar` | `answer` |', '> | `outputType` | `List(Str)` |', '> | `repairs` | `2` |', '>',
            '> Explain @topic  ', '> in two lines.', '>', '> - as a list  ', '> - of points', '',
            '## Next', '',
            '```ts', 'async function nested() {', '    ---', '    mode: agent', '', '    Do it -> @x', '    ---', '    return x;', '}', '```', '',
            '> **agent block**', '>', '> | Setting | Value |', '> | --- | --- |', '> | `restrict` | `{"fs":"./out"}` |', '>', '> Call @nested ->[Int] @n', '',
            '```ts', 'success(n);', '```', '',
        ].join('\n'));
    });

    it('demotes headings to nest a document in a larger one, outside code fences', () => {
        expect(documentMarkdown('//*\n# One\n```md\n# kept\n```\n###### Six\n*//', { demote: 2 })).toBe('### One\n```md\n# kept\n```\n###### Six\n');
    });

    it('renders one HTML page with the site styles and highlighted code', () => {
        const html = documentHtml(source, 'demo.spl');
        expect(html).toMatch(/^<!DOCTYPE html>/);
        expect(html).toContain('<title>demo.spl</title>');
        expect(html).toContain('<h1>Title</h1>');
        expect(html).toContain('<blockquote>\n<p><strong>ask block</strong></p>');
        expect(html).toContain('<span class="hljs-keyword">const</span> topic = <span class="hljs-string">&quot;x&quot;</span>;');
        expect(html).toMatch(/<style>[\s\S]*\.prose[\s\S]*<\/style>/);
        expect(html).not.toContain('<script');
    });

    it('reports syntax problems instead of documenting a broken file', () => {
        expect(() => documentMarkdown('---\nmodle: x\n\nHi\n---')).toThrow(SplSyntaxError);
    });
});

describe('spl check', () => {
    const write = (name: string, source: string): string => {
        const file = path.join(directory, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source);
        return file;
    };
    let directory: string;
    const problems = (name: string, source: string): string[] => {
        directory ??= tempDir();
        return check(write(name, source)).map(problem => `${path.relative(directory, problem.file).replaceAll('\\', '/')}:${problem.line}:${problem.column} ${problem.message}`);
    };

    it('accepts a typed workflow with blocks, the library and Node.js types', () => {
        expect(problems('ok.spl', [
            "import * as os from 'node:os';",
            'const Card = Struct("Card", { term: Str, stars: Int });',
            'let total = 0;',
            block('Describe @total on @os.platform', 'outputVar: card', 'outputType: Card'),
            agentBlock('Count stars of @card ->[Int] @=total, list -> @anything and ->[List(Card)] @cards'),
            block('-> @slugify(text: string): string', 'mode: codegen'),
            'const stars: number = card.stars + total + cards[0].stars;',
            'const slug: string = slugify(card.term);',
            'const unknownValue: unknown = anything;',
            'success({ stars, slug, unknownValue, home: process.env.HOME });',
        ].join('\n'))).toEqual([]);
    }, 60_000);

    it('reports type errors at .spl positions, inside and outside blocks', () => {
        expect(problems('bad.spl', [
            'const count: number = "three";',
            block('Sum up @missing and @count.nope', 'outputVar: text', 'outputType: Lst(Str)'),
            agentBlock('Count ->[Int] @n and ->[Str] @=count'),
            block('-> @slugify(text: string): string', 'mode: codegen'),
            'const bad: number = text;',
            'slugify(n);',
            'function sync() {', block('Hi', 'outputVar: local'), '}',
            'const count = 2;',
        ].join('\n'))).toEqual([
            'bad.spl:1:7 Type \'string\' is not assignable to type \'number\'.',
            'bad.spl:1:7 Cannot redeclare block-scoped variable \'count\'.',
            'bad.spl:4:13 Cannot find name \'Lst\'. Did you mean \'List\'?',
            'bad.spl:6:9 Cannot find name \'missing\'.',
            'bad.spl:6:28 Property \'nope\' does not exist on type \'number\'.',
            'bad.spl:12:1 Cannot assign to \'count\' because it is a constant.',
            'bad.spl:18:7 Type \'string\' is not assignable to type \'number\'.',
            'bad.spl:19:9 Argument of type \'number\' is not assignable to parameter of type \'string\'.',
            'bad.spl:21:1 \'await\' expressions are only allowed within async functions and at the top levels of modules.',
            'bad.spl:27:7 Cannot redeclare block-scoped variable \'count\'.',
        ]);
    }, 60_000);

    it('checks imported workflows and reports scanner problems without running tsc', () => {
        write('lib/helper.spl', 'export function double(n: number): number {\n    return n * "2";\n}\nsuccess(double(Number(args[0])));');
        expect(problems('main.spl', "import run, { double } from './lib/helper.spl';\nconst four: string = double(2);\nconst result: number = await run(['2']);")).toEqual([
            'lib/helper.spl:2:16 The right-hand side of an arithmetic operation must be of type \'any\', \'number\', \'bigint\' or an enum type.',
            'main.spl:2:7 Type \'number\' is not assignable to type \'string\'.',
            'main.spl:3:7 Type \'unknown\' is not assignable to type \'number\'.',
        ]);
        expect(problems('scan.spl', 'enum Color { Red }\nconst x: number = "s";')).toEqual([
            'scan.spl:1:1 Unsupported TypeScript syntax: `enum` cannot be erased; use a union of string literals instead of enum',
        ]);
        expect(fs.readdirSync(directory).filter(name => name.startsWith('.spl-check'))).toEqual([]);
    }, 60_000);
});
