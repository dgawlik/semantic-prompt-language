import { describe, expect, it } from 'vitest';
import { scan } from '../src/scanner.js';
import { block } from './helpers.js';

const messages = (source: string): string[] => scan(source).problems.map(problem => `${problem.line}:${problem.column} ${problem.message}`);
const lines = (source: string): string[] => scan(source).code.split('\n');

describe('code', () => {
    it('copies TypeScript as written', () => {
        const source = 'const x: number = 1;\nfunction f(a: string) {\n    return a;\n}\n';
        expect(scan(source)).toMatchObject({ code: source, problems: [], blocks: [], comments: [] });
    });

    it('never treats fences or comment markers inside strings, templates, regular expressions and comments as syntax', () => {
        const source = [
            'const a = `', '---', '//*', '${ `', '---', '` }', '`;',
            '/*', '---', '*/',
            "const b = '\\", "---';",
            'const c = /---|[/]`/.test(a) ? 1 / 2 : 3;',
            'const d = "//*";',
        ].join('\n');
        expect(scan(source)).toMatchObject({ code: source, problems: [], blocks: [] });
    });

    it('keeps every line in place', () => {
        const source = ['//*', '# Title', '*//', 'let a = 1;', block('Tell a joke', 'outputVar: joke'), 'success(joke);'].join('\n');
        const result = scan(source);
        expect(result.code.split('\n')).toHaveLength(source.split('\n').length);
        expect(lines(source)[3]).toBe('let a = 1;');
        expect(lines(source).at(-1)).toBe('success(joke);');
    });
});

describe('Markdown comments', () => {
    it('become blank lines and are returned as prose', () => {
        const result = scan('//*\n  # Title\n\n  Text\n*//\nlet a = 1;');
        expect(result.code).toBe('\n\n\n\n\nlet a = 1;');
        expect(result.comments).toEqual([{ line: 1, endLine: 5, text: '# Title\n\nText' }]);
    });

    it('may start on the opening line', () => {
        expect(scan('//* One line\n*//').comments[0].text).toBe('One line');
    });

    it('leave ordinary comments alone', () => {
        const source = '//** banner\n//*not markdown\n/* block */ let a = 1; // tail';
        expect(scan(source)).toMatchObject({ code: source, comments: [], problems: [] });
    });

    it('are only allowed at the top level', () => {
        expect(messages('function f() {\n    //*\n    text\n    *//\n}')).toEqual(['2:5 Markdown comments (`//*`) are only allowed at the top level']);
        expect(messages(block('Text\n//*\nmore', 'outputVar: a'))).toEqual(['5:1 Markdown comments (`//*`) are only allowed at the top level']);
    });

    it('must be closed', () => {
        expect(messages('let a = 1;\n//*\ntext')).toEqual(['2:1 Unclosed Markdown comment: `//*` needs a closing `*//` at the start of a line']);
        expect(messages('//*\ntext\n*// let a = 1;')).toEqual(['3:1 `*//` must be alone on its line']);
    });
});

describe('ask blocks', () => {
    it('become one call that declares the output', () => {
        const source = block('Tell a joke about @topic', 'outputVar: joke', 'model: openai/gpt-6', 'tokens: 256');
        expect(lines(source)).toEqual([
            'const joke = await __spl.ask({"line":1,"model":"openai/gpt-6","tokens":256,"output":"joke","text":"Tell a joke about @topic"})',
            '', '', '', '',
            '.in("topic", topic)',
            ';',
        ]);
        expect(scan(source).blocks).toEqual([{
            mode: 'ask', line: 1, endLine: 7, depth: 0, settings: { model: 'openai/gpt-6', tokens: 256 }, text: 'Tell a joke about @topic',
            inputs: [{ name: 'topic', line: 6, column: 20 }], outputs: [{ name: 'joke', line: 2, column: 12, assign: false }],
        }]);
    });

    it('place the output type on its own line', () => {
        const result = scan(block('A joke', 'outputVar: joke', 'outputType: List(Joke)'));
        expect(result.code.split('\n').slice(0, 3)).toEqual([
            'const joke = await __spl.ask({"line":1,"output":"joke","text":"A joke", "outputType":',
            '',
            'List(Joke) })',
        ]);
        expect(result.spans).toContainEqual({ line: 3, column: 13, generatedColumn: 1, length: 10 });
    });

    it('locate the output where its name is written, not inside the key', () => {
        expect(scan(block('Go', 'outputVar: output')).blocks[0].outputs).toEqual([{ name: 'output', line: 2, column: 12, assign: false }]);
        expect(scan(block('Go', 'outputVar: =Var', 'outputType: Int')).blocks[0].outputs).toEqual([{ name: 'Var', line: 2, column: 13, assign: true, type: 'Int' }]);
    });

    it('assign an existing variable with =name', () => {
        expect(lines(block('How many?', 'outputVar: =count', 'outputType: Int'))[0]).toMatch(/^count = await __spl\.ask\(/);
    });

    it('accept YAML values, lists and continuation lines', () => {
        const source = ['---', 'outputVar: a', 'enforce:', '  - Be brief', '  - Be kind', 'forbid: [jargon, "emoji: any"]', 'hide: true', 'reasoning: none',
            'repairs: 2', 'seed: 7', 'temperature: 0.5', 'topP: 1', '', 'Hello', '---'].join('\n');
        expect(scan(source).problems).toEqual([]);
        expect(scan(source).blocks[0].settings).toEqual({
            enforce: ['Be brief', 'Be kind'], forbid: ['jargon', 'emoji: any'], hide: true, reasoning: 'none', repairs: 2, seed: 7, temperature: 0.5, topP: 1,
        });
    });

    it('need outputVar and reject ->', () => {
        expect(messages(block('Tell a joke'))).toEqual(['1:1 ask block needs outputVar: name the variable that receives the answer, such as `outputVar: summary`']);
        expect(messages(block('Tell a joke -> @joke', 'outputVar: a'))).toEqual(['4:13 ask block needs outputVar: `->` declares outputs only in agent and codegen blocks']);
    });

    it('end the header at a blank line or at the first unknown key', () => {
        expect(scan(block('Note: keep it short', 'outputVar: a')).blocks[0].text).toBe('Note: keep it short');
        expect(scan('---\noutputVar: a\nSummary: of what follows\nmodel: is text here\n---').blocks[0])
            .toMatchObject({ settings: {}, text: 'Summary: of what follows\nmodel: is text here' });
    });
});

describe('header problems', () => {
    it.each([
        ['modle: x', '2:1 unknown header key `modle`; did you mean `model`?'],
        ['Model: x', '2:1 unknown header key `Model`; did you mean `model`?'],
        ['outputvar: x', '2:1 unknown header key `outputvar`; did you mean `outputVar`?'],
        ['output_type: Int', '2:1 unknown header key `output_type`; did you mean `outputType`?'],
        ['top_p: 0.5', '2:1 unknown header key `top_p`; did you mean `topP`?'],
        ['mode: chat', '2:1 `mode` must be ask, agent or codegen'],
        ['reasoning: extreme', '2:1 `reasoning` must be none, low, medium, high or max'],
        ['tokens: many', '2:1 `tokens` must be a positive integer'],
        ['repairs: 9', '2:1 `repairs` must be an integer from 0 to 5'],
        ['temperature: 3', '2:1 `temperature` must be a number from 0 to 2'],
        ['outputVar: two words', '2:1 `outputVar` must be a variable name, or =name to assign an existing variable'],
        ['restrict: ./src', '2:1 `restrict` applies only to agent blocks'],
    ])('%s', (header, message) => {
        expect(messages(`---\n${header}\n${header.startsWith('outputVar') ? '' : 'outputVar: a\n'}\nText\n---`)).toEqual([message]);
    });

    it('reports keys that do not apply to the mode', () => {
        expect(messages('---\nmode: agent\noutputVar: a\nseed: 1\n\nText\n---')).toEqual([
            '3:1 `outputVar` applies only to ask blocks', '4:1 `seed` applies only to ask blocks',
        ]);
    });

    it('reports a key set twice and invalid YAML', () => {
        expect(messages('---\noutputVar: a\noutputVar: b\n\nText\n---')).toEqual(['3:1 header key `outputVar` is set twice']);
        expect(messages('---\noutputVar: a\nenforce: [unclosed\n\nText\n---')[0]).toMatch(/^3:1 `enforce` is not valid YAML: /);
    });
});

describe('agent blocks', () => {
    it('declare outputs with -> and read every other @name', () => {
        const source = ['---', 'mode: agent', 'restrict: { fs: ./src, exec: [git, npm] }', '',
            'Call @fib with @args and @env.HOME ->[Int] @result', 'then describe @result -> @text', 'mail user@example.com or @@handle', '---'].join('\n');
        expect(scan(source).problems).toEqual([]);
        expect(lines(source)).toEqual([
            'const { result, text } = await __spl.agent({"line":1,"restrict":{"fs":"./src","exec":["git","npm"]},"text":"Call @fib with @args and @env.HOME ->[Int] @result\\nthen describe @result -> @text\\nmail user@example.com or @handle"})',
            '', '', '',
            '.in("fib", fib).in("args", args).in("env.HOME", env.HOME).out("result", Int)',
            '.out("text")',
            '',
            ';',
        ]);
    });

    it('allow spaces around the type and balanced brackets inside it', () => {
        const source = agentBlock('tags -> [ List(Union(Str, Int)) ]@tags and ->[Struct("P", { a: List(Int) })] @p');
        expect(lines(source)[3]).toBe('.out("tags", List(Union(Str, Int))).out("p", Struct("P", { a: List(Int) }))');
        expect(scan(source).spans).toEqual([
            { line: 4, column: 11, generatedColumn: 14, length: 21 },
            { line: 4, column: 47, generatedColumn: 46, length: 29 },
        ]);
    });

    it('assign existing variables with @=name', () => {
        const source = agentBlock('Count ->[Int] @=count and name -> @label');
        expect(lines(source)).toEqual([
            'const __spl1 = await __spl.agent({"line":1,"text":"Count ->[Int] @=count and name -> @label"})',
            '', '',
            '.out("count", Int).out("label")',
            '; const { label } = __spl1; count = __spl1.count;',
        ]);
    });

    it('may have no outputs and keep arrows that declare nothing as text', () => {
        expect(lines(agentBlock('Turn a -> b in ./notes.txt'))[0]).toBe('await __spl.agent({"line":1,"text":"Turn a -> b in ./notes.txt"})');
    });

    it('reject an output declared twice', () => {
        expect(messages(agentBlock('-> @a\n-> @a'))).toEqual(['5:5 output @a is declared twice in this block']);
    });

    it('mark blocks inside code as local and keep their indentation out of the text', () => {
        const source = 'async function f() {\n    ---\n    mode: agent\n\n    Do it\n      well -> @x\n    ---\n    return x;\n}';
        expect(scan(source).problems).toEqual([]);
        expect(lines(source)[1]).toBe('const { x } = await __spl.agent({"line":2,"local":true,"text":"Do it\\n  well -> @x"})');
        expect(scan(source).blocks[0].depth).toBe(1);
    });
});

function agentBlock(instruction: string): string {
    return block(instruction, 'mode: agent');
}

describe('codegen blocks', () => {
    it('declare generated functions with their signatures', () => {
        const source = block('Slug of a title -> @slugify(text: string): string\nand its helper -> @words(text: string)\n-> @anything', 'mode: codegen');
        expect(scan(source).problems).toEqual([]);
        expect(lines(source)).toEqual([
            'const { slugify, words, anything } = await __spl.codegen({"line":1,"text":"Slug of a title -> @slugify(text: string): string\\nand its helper -> @words(text: string)\\n-> @anything"})',
            '', '',
            '.fn<{ slugify(text: string): string }>("slugify")',
            '.fn<{ words(text: string): any }>("words")',
            '.fn<{ anything(...args: any[]): any }>("anything")',
            ';',
        ]);
    });

    it('map only signatures that are written in the source', () => {
        const source = block('Slug -> @slugify(text: string): string\nPad -> @pad', 'mode: codegen');
        expect(scan(source).spans).toEqual([{ line: 4, column: 17, generatedColumn: 14, length: 22 }]);
    });

    it('need a function', () => {
        expect(messages(block('Something useful', 'mode: codegen'))).toEqual(['1:1 codegen block needs a function to generate, such as `-> @slugify(text: string): string`']);
    });
});

describe('fences and placement', () => {
    it('name the unmatched opening line', () => {
        expect(messages(`${block('One', 'outputVar: a')}\nlet b = 1;\n---\noutputVar: c\n\nTwo`))
            .toEqual(['7:1 Unmatched block opened at line 7: every `---` needs a closing `---`']);
    });

    it('reject blocks in expression position', () => {
        const message = 'Blocks are statements: a `---` block cannot be used as an expression';
        expect(messages(`const x =\n${block('One', 'outputVar: a')}`)).toEqual([`2:1 ${message}`]);
        expect(messages(`f(\n${block('One', 'outputVar: a')}\n)`)).toEqual([`2:1 ${message}`]);
        expect(messages(`const f = () =>\n${block('One', 'outputVar: a')}`)).toEqual([`2:1 ${message}`]);
    });

    it('accept blocks wherever a statement may stand', () => {
        const one = block('One', 'outputVar: a');
        for (const source of [`let i = 0\ni++\n${one}`, `if (x) {\n${one}\n} else {\n${one}\n}`, `for (const item of items) {\n${one}\n}`, `try {\n${one}\n} finally {}`, `const f = async () => {\n${one}\n}`]) {
            expect(messages(source)).toEqual([]);
        }
    });
});

describe('regions', () => {
    it('list every pair of fences with its header, also when the block is rejected or still open', () => {
        const source = ['---', 'model: x', '---', 'let a = 1;', '---', '  mode: agent', '  restrict:', '    fs: ./out', 'unknown: text', '---', '---', '', '---', '---', 'outputVar: b', 'modle: y', '', 'Still typing'].join('\n');
        expect(scan(source).regions).toEqual([
            { line: 1, endLine: 3, open: false, mode: 'ask', bodyLine: 3, header: [{ name: 'model', line: 2, column: 1 }] },
            { line: 5, endLine: 10, open: false, mode: 'agent', bodyLine: 9, header: [{ name: 'mode', line: 6, column: 3 }, { name: 'restrict', line: 7, column: 3 }] },
            { line: 11, endLine: 13, open: false, mode: 'ask', bodyLine: 12, header: [] },
            { line: 14, endLine: 18, open: true, mode: 'ask', bodyLine: 17, header: [{ name: 'outputVar', line: 15, column: 1 }] },
        ]);
    });
});

describe('file defaults', () => {
    it('are a block without an instruction at the start of the file', () => {
        const result = scan('// Header comment\n//*\nIntro\n*//\n---\nmodel: gpt-6-luna\nreasoning: low\nenforce: Be brief\n---\nlet a = 1;');
        expect(result.problems).toEqual([]);
        expect(result.defaults).toEqual({ line: 5, endLine: 9, settings: { model: 'gpt-6-luna', reasoning: 'low', enforce: ['Be brief'] } });
        expect(result.code.split('\n').slice(4, 9)).toEqual(['', '', '', '', '']);
    });

    it('must come first', () => {
        expect(messages('let a = 1;\n---\nmodel: x\n---')).toEqual(['2:1 File defaults must come first: a block without an instruction sets defaults for the whole file']);
        expect(messages('---\nmodel: x\n---\n---\nmodel: y\n---')).toEqual(['4:1 File defaults must come first: a block without an instruction sets defaults for the whole file']);
    });

    it('accept only settings that apply to every block', () => {
        expect(messages('---\nmodel: x\noutputVar: a\nmode: agent\n---')).toEqual([
            '3:1 `outputVar` cannot be a file default; it belongs to a block with an instruction',
            '4:1 `mode` cannot be a file default; it belongs to a block with an instruction',
        ]);
    });

    it('reject an empty block', () => {
        expect(messages('---\n\n---')).toEqual(['1:1 empty block: write an instruction between the `---` lines']);
    });
});

describe('SPL 2.x syntax', () => {
    it.each([
        ['{js}\nlet a = 1;\n{/js}', [1, 3]],
        ["{agent model='x',\n  reasoning='low'}\nDo it\n{/agent}", [1, 4]],
        ['{comment}\ntext\n{/comment}', [1, 3]],
        ['```js\nlet a = 1;\n```', [1, 3]],
        ["---\nextension: 'semantic-prompt-language'\nversion: 1\n---", [2, 3]],
    ])('%s', (source, expected) => {
        const problems = scan(source).problems.filter(problem => problem.message === 'SPL 2.x syntax; see the migration guide');
        expect(problems.map(problem => problem.line)).toEqual(expected);
    });
});

describe('TypeScript that cannot be erased', () => {
    it.each([
        ['enum Color { Red }', '1:1 Unsupported TypeScript syntax: `enum` cannot be erased; use a union of string literals instead of enum'],
        ['const enum Color { Red }', '1:7 Unsupported TypeScript syntax: `enum` cannot be erased; use a union of string literals instead of enum'],
        ['namespace Shapes { export const a = 1; }', '1:1 Unsupported TypeScript syntax: `namespace` cannot be erased; use an ES module or a plain object instead of namespace'],
        ['class A {\n    constructor(private readonly x: number, y: number) {}\n}', '2:17 Unsupported TypeScript syntax: parameter properties cannot be erased; declare the field and assign it in the constructor'],
        ['@sealed\nclass A {}', '1:1 Unsupported TypeScript syntax: decorators cannot be erased; call the decorator as a function instead'],
    ])('%s', (source, message) => {
        expect(messages(source)).toEqual([message]);
    });

    it('accepts the same words where they are ordinary names', () => {
        expect(messages('const schema = { enum: ["a"], type: "string" };\nconst b = schema.enum;\ndeclare namespace Ambient { const a: number }\nclass A { constructor(x: number) { const readonly = x; } }')).toEqual([]);
    });
});
