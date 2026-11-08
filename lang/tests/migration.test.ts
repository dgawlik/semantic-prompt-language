import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { parseMarkdown } from '../src/markdown.js';
import { parse } from '../src/parser.js';
import { NoLlm } from './helpers.js';

const exec = (source: string) => run(parse(source), { backend: new NoLlm(), logger: new Logger('silent') });

describe('manual source migration', () => {
    it.each([
        "if True { pass }",
        "def greet() { return 'Hello' }",
        "let data = {'name': 'Ada'}",
        "success {}",
    ])('gives an actionable error for removed braces: %s', (source) => {
        expect(() => parse(source)).toThrow(/brace|object|indent/i);
    });

    it.each(["if True:\n  pass", "if True:\n\tpass", "if True:\n        pass"])(
        'rejects indentation that is not exactly four spaces: %s', (source) => {
            expect(() => parse(source)).toThrow(/four|4|tabs/i);
        },
    );

    it('preserves raw JSON while object expressions use indentation in calls, lists and schemas', async () => {
        const result = await exec(`let data = object:
    'nested': object:
        'name': 'Ada'
    'empty': object()
let values = [object:
    'value': data.nested.name
, 2]
success [json_parse(r'{"name":"Ada"}'), values, data.empty]`);
        expect(result).toMatchObject({
            status: 'success', value: [{ name: 'Ada' }, [{ value: 'Ada' }, 2], {}],
        });
    });

    it('runs the maintained typed-data example without a provider', async () => {
        const source = fs.readFileSync(path.resolve(__dirname, '..', 'examples', 'typed-data.md'), 'utf8');
        const result = await run(parseMarkdown(source), { backend: new NoLlm(), logger: new Logger('silent') });
        expect(result).toMatchObject({
            status: 'success', value: { name: 'Ada', favorite: 'blue', address: { city: 'London', postalCode: null } },
        });
    });

    it('distinguishes new conversions from unchanged untyped numeric literals', async () => {
        expect(await exec("success [1, 1.0, int('42'), json_stringify(float('1.0'))]")).toMatchObject({
            status: 'success', value: [1, 1, 42n, '1.0'],
        });
    });

    it.each(["int(True)", "int(1.5)", "int('1.5')", "int('9223372036854775808')", "float('Infinity')"])(
        'rejects removed numeric coercions rather than truncating or accepting nonfinite values: %s', async (conversion) => {
            expect(await exec(`success ${conversion}`)).toMatchObject({ status: 'failure' });
        },
    );
});
