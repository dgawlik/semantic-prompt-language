import { describe, expect, it } from 'vitest';
import { SplSyntaxError } from '../src/errors.js';
import { parse } from '../src/parser.js';

const bad = (src: string, message: RegExp) => {
    try {
        parse(src);
    } catch (e) {
        expect(e).toBeInstanceOf(SplSyntaxError);
        expect((e as SplSyntaxError).message).toMatch(message);
        return;
    }
    throw new Error(`expected a syntax error for: ${src}`);
};

describe('parser: accepted syntax', () => {
    it('parses the PRD examples', () => {
        const src = `
@{model='gpt-terra-6'}
let response = ?{len='sentence', fmt='object'} 'A joke about programmers'
let firstName = response.firstName
think{level='low', show=True} 'Why are tests not passing'
think{level='high'} 'What is the meaning of life'
enforce 'Users favorite color is red' {
    let color = ?'What is my favorite color?'
}
forbid 'swearing' { let x = ?'hi' }
restrict './target/out' {
    think 'Run tests and write to tests.log'
}
restrict net 'api.example.com' { let a = ?'x' }
restrict exec 'npm,git' { let a = ?'x' }
let readme = read_file{path='./README.md'} 'Return the file content'
try {
    let r = ?{fmt='object'} 'A joke about programmers'
} except err {
    let r = {'setup': 'none', 'punchline': err.reason}
}
assert 1==2 'Abnormal'
fail 'Mysterious reason'
success response
`;
        const p = parse(src);
        expect(p.directives.model).toBe('gpt-terra-6');
        expect(p.body.length).toBeGreaterThan(10);
    });

    it('supports control flow, functions and expressions', () => {
        const p = parse(`
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
}
`);
        expect(p.body.length).toBeGreaterThan(8);
    });

    it('accepts else/except on the next line', () => {
        parse(`if True {\n pass\n}\nelse {\n pass\n}\ntry {\n pass\n}\nexcept e {\n pass\n}`);
    });

    it('treats escapes and raw strings', () => {
        parse(`let a = 'a\\n{{b}}'\nlet b = r'{no} \\interp'\nlet c = '''multi\nline {a}'''`);
    });
});

describe('parser: strict syntax errors', () => {
    it('rejects unknown modifiers and values', () => {
        bad(`let a = ?{verbose=True} 'x'`, /unknown modifier 'verbose'/);
        bad(`let a = ?{len='huge'} 'x'`, /invalid value 'huge'/);
        bad(`let a = ?{len=True} 'x'`, /invalid value True/);
        bad(`think{level='extreme'} 'x'`, /invalid value 'extreme'/);
        bad(`think{show='yes'} 'x'`, /invalid value 'yes'/);
        bad(`think{fmt='object'} 'x'`, /unknown modifier 'fmt' for 'think'/);
        bad(`let a = ?{len='word', len='word'} 'x'`, /duplicate modifier/);
    });

    it('rejects bad tool calls', () => {
        bad(`read_file{file='x'} 'y'`, /unknown parameter 'file'/);
        bad(`read_file{} 'y'`, /requires parameter 'path'/);
        bad(`read_file 'y'`, /requires parameters/);
        bad(`shell{command='ls'}`, /requires a prompt/);
    });

    it('rejects structural mistakes', () => {
        bad(`try { pass }`, /requires an 'except/);
        bad(`break`, /outside of a loop/);
        bad(`return 1`, /outside of a function/);
        bad(`def f() { while True { def g() { break } } }`, /outside of a loop/);
        bad(`pass\n@{model='x'}`, /only allowed at the top/);
        bad(`@{colour='x'}`, /unknown directive/);
        bad(`@{model=x}`, /quoted string/);
        bad(`let if = 1`, /reserved word/);
        bad(`1 = 2`, /invalid assignment target/);
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
            expect((e as SplSyntaxError).line).toBe(2);
            return;
        }
        throw new Error('expected error');
    });
});
