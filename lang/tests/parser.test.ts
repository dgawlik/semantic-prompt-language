import { describe, expect, it } from 'vitest';
import { SplSyntaxError } from '../src/errors.js';
import { tokenize } from '../src/lexer.js';
import { blockLocalDeclarations, parse } from '../src/parser.js';

const bad = (source: string, message: RegExp) => {
    expect(() => parse(source)).toThrow(SplSyntaxError);
    expect(() => parse(source)).toThrow(message);
};

describe('blockLocalDeclarations', () => {
    it('finds let declarations inside nested blocks, but not top-level or function locals', () => {
        const program = parse(`let top =:
    let inner = 1
    inner
if True:
    let branch = 1
else:
    let other = 2
for i in [1]:
    let looped = i
enforce 'x':
    forbid 'y':
        let guided = ask 'z'
try:
    let attempted = 1
except err:
    let handled = 2
restrict './out':
    let limited = 1
def f():
    let local = 1
    if True:
        let deeper = 2`);
        expect([...blockLocalDeclarations(program)].sort()).toEqual(
            ['attempted', 'branch', 'guided', 'handled', 'inner', 'limited', 'looped', 'other'],
        );
    });
});

describe('parser: accepted syntax', () => {
    it.each(['ask', 'think', 'agent'])('parses multiline %s modifiers, nested values, and trailing commas', (command) => {
        const program = parse(`let score = ${command}(
    fmt = 'integer',
    repairs = 1,
    schema = {
        'type': 'integer',
        'minimum': min([1, 2]),
    },
    model = choose('one', 'two'),
) 'Rate this issue'`);
        expect(program.body[0]).toMatchObject({ value: {
            t: command,
            mods: {
                fmt: { t: 'str', parts: ['integer'] },
                repairs: { t: 'num', v: 1 },
                schema: { t: 'dict' },
                model: { t: 'call' },
            },
            prompt: { t: 'str', parts: ['Rate this issue'] },
        } });
        parse(`${command} 'prompt'\n${command}() 'prompt'\n${command}() ('a' + 'b')`);
        parse(`${command}(\n# modifiers can contain comments\nfmt='text',\n) get_prompt()`);
    });

    it('parses multiline headers and log options without changing positional calls', () => {
        const program = parse(`@(
    model = 'test',
)
log(
    level = debug,
)(
    len([1, 2]),
)
log('ordinary positional call')
log()`);
        expect(program.directives).toEqual({ model: 'test' });
        expect(program.body[0]).toMatchObject({ e: { t: 'log', level: { t: 'str', parts: ['debug'] } } });
        expect(program.body[1]).toMatchObject({ e: { t: 'call', callee: { t: 'name', name: 'log' } } });
    });

    it('accepts special variables in expressions, interpolation and modifiers', () => {
        const program = parse(`let date = $env.date\nlog($args[0], '{$env.date}: {$args[1]}')\nsuccess ask(model=$args[2]) $env.PROMPT`);
        expect(program.body[0]).toMatchObject({ value: { t: 'member', obj: { t: 'special', name: 'env' } } });
    });

    it('uses enforce/forbid for positive and negative scoped guidance', () => {
        const program = parse(`enforce 'English':
    forbid 'jokes':
        let answer = ask 'Hi'`);
        expect(program.body[0]).toMatchObject({
            t: 'constraint', kind: 'enforce', body: [{ t: 'constraint', kind: 'forbid' }],
        });
    });

    it('composes generation options and explicit agents', () => {
        parse(`
@(model='test-model')
let Contract = {'type': 'object'}
let response = ask(schema=Contract, reasoning='high', repairs=2, model='other') 'Extract'
let diagnosis = think(fmt='json', hide=True) 'Diagnose'
enforce 'Answer in English':
    forbid 'jokes':
        let result = ask 'Hi'
restrict './out', exec 'git', mcp 'docs/search':
    agent 'Write the report'
let text = read_file('input.txt')
write_file('output.txt', text)
let output = shell('git status')
let page = web_fetch('https://example.com')
let hits = web_search('SPL')
success response`);
    });

    it('supports control flow, expressions, declarations and assignments', () => {
        const program = parse(`
def f(a, b):
    return a + b
let x = f(1, 2) * 3 ** 2 // 4 % 5
if x > 1 and not x == 3:
    pass
elif x in [1,2]:
    pass
else:
    pass
for i, v in enumerate(['a']):
    continue
while False:
    break
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
        expect(parse(`restrict './src', net 'example.com', exec 'npm,git', mcp ['docs/search', 'issues']:
    pass`).body[0]).toMatchObject({
            t: 'restrict', clauses: [{ kind: 'fs' }, { kind: 'net' }, { kind: 'exec' }, { kind: 'mcp' }],
        });
        parse(`restrict fs './a',
'./b', mcp 'docs/*':
    pass`);
        bad(`restrict './src',:
    pass`, /expected|unexpected/);
    });

    it('retains prefix operator precedence', () => {
        const program = parse(`let a = ask 'x' + 'y'\nlet b = -ask(len='word') 'n'\nlet c = not ask 'q'`);
        expect(program.body[0]).toMatchObject({ value: { t: 'binary', l: { t: 'ask' } } });
        expect(program.body[1]).toMatchObject({ value: { t: 'unary', e: { t: 'ask' } } });
    });

    it('accepts grouping blocks, top-level return and next-line else/except', () => {
        parse(`let color = 'Blue'
:
    let color = 'Red'
return color`);
        parse(`if True:
    pass
else:
    pass
try:
    pass
except e:
    pass`);
        parse(`for i in [1]:
    :
        return i
restrict './x':
    enforce 'a':
        return`);
    });

    it('accepts block and conditional expressions without confusing dictionaries', () => {
        const program = parse(`let x = if True:
    1
else:
    2
let y =:
    let n = 2
    n + 1
let d = {'key': x}`);
        expect(program.body[0]).toMatchObject({ value: { t: 'if' } });
        expect(program.body[1]).toMatchObject({ value: { t: 'block' } });
        expect(program.body[2]).toMatchObject({ value: { t: 'dict' } });
        parse(`success (if True:
    let x = 1
    x
else:
    0
) + 2`);
    });

    it('accepts bare, quoted and expression-valued log levels', () => {
        parse(`log(level=debug)('x')\nlog(level='error')(1, 2)\nlog(level=chosen)('x')\nlog()()`);
        bad(`log(other=1)('x')`, /unknown modifier/);
        bad(`log(level=info, level=debug)('x')`, /duplicate modifier/);
        bad(`log(level=debug) 'x'`, /expected '\('/);
        bad(`ask(level=debug) 'x'`, /unknown modifier/);
    });

    it('treats escapes, raw strings and multiline interpolation', () => {
        parse(`let a = 'a\\n{{b}}'\nlet b = r'{no} \\interp'\nlet c = '''multi\nline {a}'''`);
    });
});

describe('parser: strict syntax errors', () => {
    it('requires colon-delimited headers and multiline indented bodies', () => {
        bad('if True { pass }', /brace-delimited blocks have been removed/);
        bad('def f() { return 1 }', /brace-delimited blocks have been removed/);
        bad('let x = { let n = 1; n }', /unexpected keyword/);
        bad('if True\n    pass', /expected ':'|unexpected indentation/);
        bad('if True: pass', /expected a newline/);
        bad('if True:\npass', /expected an indented block/);
        bad('if True:\n    # only a comment', /expected an indented block/);
        bad('if True:', /expected an indented block/);
    });

    it('rejects unexpected indentation, inconsistent dedents and indentation tabs', () => {
        bad('  pass', /unexpected indentation/);
        bad('if True:\n    pass\n  pass', /inconsistent dedent/);
        bad('if True:\n    pass\n        pass', /unexpected indentation/);
        bad('if True:\n\tpass', /tabs are not allowed/);
        bad('if True:\n \tpass', /tabs are not allowed/);
        bad('if True:\n    pass\nelse:\npass', /expected an indented block/);
    });

    it('explains migration from removed command and modifier syntax', () => {
        bad(`? 'prompt'`, /removed; use ask/);
        bad(`?{fmt='integer'} 'prompt'`, /removed; use ask/);
        bad(`ask{fmt='integer'} 'prompt'`, /use ask\(\.\.\.\)/);
        bad(`think{reasoning='high'} 'prompt'`, /use think\(\.\.\.\)/);
        bad(`agent{model='test'} 'prompt'`, /use agent\(\.\.\.\)/);
        bad(`log{level=debug}(1)`, /use log\(level=debug\)\(value\)/);
        bad(`@{model='test'}`, /use @\(model=/);
    });

    describe('indentation tokens', () => {
        it('emits nested INDENT/DEDENT tokens, including both dedents at EOF', () => {
            const tokens = tokenize('if True:\n    while False:\n        pass');
            expect(tokens.map(token => token.type === 'name' || token.type === 'op' ? token.value : token.type))
                .toEqual(['if', 'True', ':', 'nl', 'indent', 'while', 'False', ':', 'nl', 'indent', 'pass', 'nl', 'dedent', 'dedent', 'eof']);
            expect(tokens.find(token => token.type === 'indent')).toMatchObject({ line: 2, col: 5 });
        });

        it('ignores blank and comment-only indentation, and accepts any consistent space width', () => {
            const program = parse('if True:\n# a comment\n\n  pass\n       # still a comment\n  if False:\n     pass\n  pass\npass');
            expect(program.body).toHaveLength(2);
            expect(program.body[0]).toMatchObject({ t: 'if', branches: [{ body: [{ t: 'pass' }, { t: 'if' }, { t: 'pass' }] }] });
        });

        it('suppresses continuation indentation and handles CRLF and explicit continuations', () => {
            parse(`if (
     True and
        False
    ):
        let data = {
      'key':
            [1,
     2],
        }
        let slice = data['key'][1:
     2]
        let total = 1 + \\
    2
        pass`.replace(/\n/g, '\r\n'));
        });

        it('uses the header indentation, not the closing parenthesis indentation', () => {
            parse(`if (
        True
        ):
        pass
def f(
        x,
        ):
        return x
enforce (
        'English'
        ):
        pass`);
        });

        it('does not confuse dictionary member keys or slices with suite headers', () => {
            parse(`let data = {
        obj.enforce:
            1,
        obj.def:
            2,
}
let sliced = [1, 2][:
        1]
success [not if True:
        False
else:
        True
]`);
        });

        it('ends a suite expression before a new statement or unary expression', () => {
            const program = parse('let x = :\n    1\n+2\nassert :\n    True\n"not an assert message"');
            expect(program.body.map(stmt => stmt.t)).toEqual(['let', 'expr', 'assert', 'expr']);
            expect(program.body[0]).toMatchObject({ value: { t: 'block' } });
            expect(program.body[2]).not.toHaveProperty('message', expect.anything());
        });

        it('leaves multiline strings and interpolation untouched', () => {
            parse(`if True:
        let text = '''first
    unindented { {'x': 1}['x'] }
        last'''
        let literal = r'{not code}'
        pass`);
        });

        it('does not parse a following if statement as a ternary or leak a suite into it', () => {
            const program = parse('let x = :\n    1\nif True:\n    pass\nif False:\n    pass');
            expect(program.body.map(stmt => stmt.t)).toEqual(['let', 'if', 'if']);
        });
    });

    it.each(['ask', 'think', 'agent'])('requires named %s modifiers and an external prompt', (command) => {
        bad(`${command}('prompt')`, /modifier name.*prompt belongs after/);
        bad(`${command}(fmt='integer')`, /requires a prompt/);
        bad(`${command}(fmt='integer' repairs=1) 'prompt'`, /expected ',' or '\)'/);
        bad(`${command}(fmt='integer', fmt='text') 'prompt'`, /duplicate modifier/);
        bad(`${command}(unknown=1) 'prompt'`, /unknown modifier/);
        bad(`${command}(show=True) 'prompt'`, /unknown modifier.*show/);
        bad(`${command}(hide=True, hide=False) 'prompt'`, /duplicate modifier/);
        bad(`${command}(fmt='integer'\n 'prompt'`, /unclosed/);
    });

    it('reserves ask for generation rather than a variable or user function', () => {
        bad(`let ask = 1`, /reserved word/);
        bad(`def ask() { pass }`, /reserved word/);
        bad(`def f(ask) { pass }`, /reserved word/);
    });

    it('rejects unknown special variables and rebinding their names', () => {
        bad(`success $unknown`, /unknown special variable/);
        bad(`success $env_extra`, /unknown special variable/);
        bad(`success $env.$args`, /expected a member name/);
        for (const name of ['$env', '$args']) {
            bad(`let ${name} = 1`, /special variable/);
            bad(`${name} = None`, /invalid assignment target/);
            bad(`${name} += []`, /invalid assignment target/);
            bad(`def f(${name}):
    pass`, /special variable/);
            bad(`def ${name}():
    pass`, /special variable/);
            bad(`for ${name} in []:
    pass`, /special variable/);
            bad(`try:
    pass
except ${name}:
    pass`, /special variable/);
        }
    });

    it('rejects unknown or duplicate modifiers, but allows expression values', () => {
        bad(`ask(verbose=True) 'x'`, /unknown modifier/);
        bad(`think(level='high') 'x'`, /unknown modifier/);
        bad(`ask(len='word', len='word') 'x'`, /duplicate modifier/);
        parse(`ask(len=chosen_length, schema=make_schema(), repairs=1+1) 'x'`);
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
        bad(`try:
    pass`, /requires an 'except/);
        bad(`break`, /outside of a loop/);
        bad(`def f():
    while True:
        def g():
            break`, /outside of a loop/);
        bad(`pass\n@(model='x')`, /only allowed at the top/);
        bad(`@(colour='x')`, /unknown directive/);
        bad(`@(model=x)`, /quoted string/);
        bad(`let if = 1`, /reserved word/);
        bad(`let enforce = 1`, /reserved word/);
        bad(`def f(forbid) { pass }`, /reserved word/);
        bad(`let a = 1 2`, /end of statement/);
        bad(`let a = 'unterminated`, /unterminated string/);
        bad(`let a = 'x {1 +} y'`, /interpolation|unexpected/);
        bad(`let a = 'x } y'`, /single '\}'/);
        bad(`let a = 'bad \\q'`, /invalid escape/);
        bad(`let a = (1`, /unclosed/);
        bad(`if True\n:\n    pass`, /expected ':'/);
        bad(`let a = 1 $ 2`, /unexpected character/);
        bad(`def f(a, a) { }`, /duplicate parameter/);
        bad(`else { }`, /without matching/);
    });

    it('reports positions', () => {
        try {
            parse(`let a = 1\nlet b = ask(x=1) 'q'`);
        } catch (e) {
            expect(e).toMatchObject({ line: 2 });
            return;
        }
        throw new Error('expected error');
    });
});
