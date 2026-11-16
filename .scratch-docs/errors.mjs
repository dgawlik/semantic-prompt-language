import { scan } from '../lang/dist/scanner.js';
import { compile } from '../lang/dist/compile.js';
const cases = {
  odd: `const a = 1;\n---\noutputVar: x\n\nHello\n`,
  expr: `const x =\n---\noutputVar: y\n\nHello\n---\n`,
  nestedComment: `function f() {\n    //*\n    text\n    *//\n}\n`,
  commentInBlock: `---\noutputVar: x\n\n//*\nHello\n*//\n---\n`,
  unclosed: `//*\n# Title\n`,
  closeNotAlone: `//*\n# Title\n*// trailing\n`,
  misspelled: `---\nmodle: gpt-6-luna\noutputVar: x\n\nHello\n---\n`,
  wrongMode: `---\nmode: agent\noutputVar: x\n\nHello -> @y\n---\n`,
  wrongMode2: `---\nrestrict: ./out\noutputVar: x\n\nHello\n---\n`,
  noOutputVar: `---\nreasoning: low\n\nHello\n---\n`,
  arrowInAsk: `---\noutputVar: x\n\nHello -> @y\n---\n`,
  defaultsLate: `const a = 1;\n---\nmodel: gpt-6-luna\n---\n`,
  defaultsTwice: `---\nmodel: gpt-6-luna\n---\n---\nreasoning: low\n---\n`,
  defaultsBadKey: `---\nmode: agent\noutputVar: x\n---\n`,
  empty: `---\n---\n`,
  legacyTag: `{js}\nconst a = 1;\n{/js}\n`,
  legacyFence: '```js\nconst a = 1;\n```\n',
  legacyKey: `---\nextension: semantic-prompt-language\nversion: 1\n---\n`,
  enum: `enum Color { Red, Green }\n`,
  namespace: `namespace A { export const b = 1; }\n`,
  decorator: `@sealed\nclass A {}\n`,
  paramProps: `class A {\n    constructor(private x: number) {}\n}\n`,
  twice: `---\nmodel: a\nmodel: b\noutputVar: x\n\nHello\n---\n`,
  badYaml: `---\nenforce: [a\noutputVar: x\n\nHello\n---\n`,
  badValue: `---\nreasoning: extreme\noutputVar: x\nrepairs: 9\ntokens: -1\nhide: yes\ntemperature: 3\ntopP: 2\nseed: -1\nmode: fast\n\nHello\n---\n`,
  outTwice: `---\nmode: agent\n\nA -> @x and B -> @x\n---\n`,
  codegenNone: `---\nmode: codegen\n\nSlug\n---\n`,
  codegenAssign: `---\nmode: codegen\n\nSlug -> @=slugify(text: string): string\n---\n`,
  outputTypeEmpty: `---\noutputVar: x\noutputType:\n\nHello\n---\n`,
  exportDefault: `export default 1;\n`,
  exportUses: `const base = 2;\nexport function double(n: number) { return n * base; }\n`,
  exportSpec: `const base = 2;\nexport { base };\n`,
  nonAsync: `function f() {\n    ---\n    outputVar: x\n\n    Hello\n    ---\n    return x;\n}\n`,
  invalidTs: `const = 1;\n`,
};
for (const [name, source] of Object.entries(cases)) {
  const s = scan(source);
  if (s.problems.length) { for (const p of s.problems) console.log(`${name}: [scan ${p.line}:${p.column}] ${p.message}`); continue; }
  try { compile(source); console.log(`${name}: ok`); } catch (e) { console.log(`${name}: [compile ${e.line}:${e.col}] ${e.message}`); }
}
