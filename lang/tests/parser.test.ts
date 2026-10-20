import { describe, expect, it } from 'vitest';
import { SplSyntaxError } from '../src/errors.js';
import { parse } from '../src/parser.js';

const bad = (source: string, message: RegExp) => {
    expect(() => parse(source)).toThrow(SplSyntaxError);
    expect(() => parse(source)).toThrow(message);
};

describe('parser: accepted syntax', () => {
    it('uses enforce/forbid for positive and negative scoped guidance', () => {
        const program = parse(`enforce 'English' { forbid 'jokes' { let answer = ?'Hi' } }`);
        expect(program.body[0]).toMatchObject({
            t: 'constraint', kind: 'enforce', body: [{ t: 'constraint', kind: 'forbid' }],
        });
    });

    it('composes generation options and explicit agents', () => {
        parse(`
@{model='test-model'}
let Contract = {'type': 'object'}
let response = ?{schema=Contract, reasoning='high', repairs=2, model='other'} 'Extract'
let diagnosis = think{fmt='json', show=True} 'Diagnose'
enforce 'Answer in English' { forbid 'jokes' { let result = ?'Hi' } }
restrict './out', exec 'git', mcp 'docs/search' { agent 'Write the report' }
let text = read_file('input.txt')
write_file('output.txt', text)
let output = shell('git status')
let page = web_fetch('https://example.com')
let hits = web_search('SPL')
success response`);
    });

    it('supports control flow, expressions, declarations and assignments', () => {
        const program = parse(`
def f(a, b) { return a + b }
let x = f(1, 2) * 3 ** 2 // 4 % 5
if x > 1 and not x == 3 { pass } elif x in [1,2] { pass }
else { pass }
for i, v in enumerate(['a']) { continue }
while False { break }
let s = 'a{x + 1}b'[1:2]
let t = x if x else None
x += 1
d['k'] = 2
d.k = 3
let multi = {
    'a': 1,
    'b': [1, 2,
          3],
}`);
        expect(program.body.filter(s => s.t === 'assign')).toHaveLength(3);
    });

    it('parses combined restrictions and preserves commas in values', () => {
        expect(parse(`restrict './src', net 'example.com', exec 'npm,git', mcp ['docs/search', 'issues'] { pass }`).body[0]).toMatchObject({
            t: 'restrict', clauses: [{ kind: 'fs' }, { kind: 'net' }, { kind: 'exec' }, { kind: 'mcp' }],
        });
        parse(`restrict fs './a',\n './b', mcp 'docs/*' { pass }`);
        bad(`restrict './src', { pass }`, /expected|unexpected/);
    });

    it('retains prefix operator precedence', () => {
        const program = parse(`let a = ?'x' + 'y'\nlet b = -?{len='word'} 'n'\nlet c = not ?'q'`);
        expect(program.body[0]).toMatchObject({ value: { t: 'binary', l: { t: 'ask' } } });
        expect(program.body[1]).toMatchObject({ value: { t: 'unary', e: { t: 'ask' } } });
    });

    it('accepts grouping blocks, top-level return and next-line else/except', () => {
        parse(`let color = 'Blue'\n{ let color = 'Red' }\nreturn color`);
        parse(`if True { pass }\nelse { pass }\ntry { pass }\nexcept e { pass }`);
        parse(`for i in [1] { { return i } }\nrestrict './x' { enforce 'a' { return } }`);
    });

    it('accepts block and conditional expressions without confusing dictionaries', () => {
        const program = parse(`let x = if True { 1 } else { 2 }\nlet y = { let n = 2; n + 1 }\nlet d = {'key': x}`);
        expect(program.body[0]).toMatchObject({ value: { t: 'if' } });
        expect(program.body[1]).toMatchObject({ value: { t: 'block' } });
        expect(program.body[2]).toMatchObject({ value: { t: 'dict' } });
        parse(`success (if True {\nlet x = 1\nx\n} else { 0 }) + 2`);
    });

    it('accepts bare, quoted and expression-valued log levels', () => {
        parse(`log{level=debug}('x')\nlog{level='error'}(1, 2)\nlog{level=chosen}('x')\nlog{}()`);
        bad(`log{other=1}('x')`, /unknown modifier/);
        bad(`log{level=info, level=debug}('x')`, /duplicate modifier/);
        bad(`log{level=debug} 'x'`, /expected '\('/);
        bad(`?{level=debug} 'x'`, /unknown modifier/);
    });

    it('treats escapes, raw strings and multiline interpolation', () => {
        parse(`let a = 'a\\n{{b}}'\nlet b = r'{no} \\interp'\nlet c = '''multi\nline {a}'''`);
    });
});

describe('parser: strict syntax errors', () => {
    it('rejects unknown or duplicate modifiers, but allows expression values', () => {
        bad(`?{verbose=True} 'x'`, /unknown modifier/);
        bad(`think{level='high'} 'x'`, /unknown modifier/);
        bad(`?{len='word', len='word'} 'x'`, /duplicate modifier/);
        parse(`?{len=chosen_length, schema=make_schema(), repairs=1+1} 'x'`);
    });

    it('rejects removed tool-command syntax', () => {
        bad(`read_file{path='a'} 'Read'`, /end of statement/);
        bad(`read_file 'Read a'`, /end of statement/);
    });

    it('points obsolete guidance spellings to enforce/forbid', () => {
        bad(`instruct 'English' { pass }`, /use 'enforce' instead of 'instruct'/);
        bad(`avoid 'jokes' { pass }`, /use 'forbid' instead of 'avoid'/);
    });

    it('allows only name declarations and valid assignment targets', () => {
        bad(`let x`, /expected '='/);
        bad(`let 1 = 2`, /expected a variable name/);
        bad(`let f() = 2`, /expected '='/);
        bad(`let d.k = 2`, /expected '='/);
        bad(`let x += 1`, /expected '='/);
        bad(`f() = 2`, /invalid assignment target/);
        bad(`'x' ?`, /end of statement/);
    });

    it('rejects structural mistakes', () => {
        bad(`try { pass }`, /requires an 'except/);
        bad(`break`, /outside of a loop/);
        bad(`def f() { while True { def g() { break } } }`, /outside of a loop/);
        bad(`pass\n@{model='x'}`, /only allowed at the top/);
        bad(`@{colour='x'}`, /unknown directive/);
        bad(`@{model=x}`, /quoted string/);
        bad(`let if = 1`, /reserved word/);
        bad(`let enforce = 1`, /reserved word/);
        bad(`def f(forbid) { pass }`, /reserved word/);
        bad(`let a = 1 2`, /end of statement/);
        bad(`let a = 'unterminated`, /unterminated string/);
        bad(`let a = 'x {1 +} y'`, /interpolation|unexpected/);
        bad(`let a = 'x } y'`, /single '\}'/);
        bad(`let a = 'bad \\q'`, /invalid escape/);
        bad(`let a = (1`, /unclosed/);
        bad(`if True\n{ pass }`, /expected '\{'/);
        bad(`let a = 1 $ 2`, /unexpected character/);
        bad(`def f(a, a) { }`, /duplicate parameter/);
        bad(`else { }`, /without matching/);
    });

    it('reports positions', () => {
        try {
            parse(`let a = 1\nlet b = ?{x=1} 'q'`);
        } catch (e) {
            expect(e).toMatchObject({ line: 2 });
            return;
        }
        throw new Error('expected error');
    });
});
