import hljs from '../lang/dist/highlight.js';
const show = (text, language = 'spl') => { console.log('-----'); console.log(hljs.highlight(text, { language }).value); };
show(`//*
# Title

Prose with \`code\`, a rule:

---

model: not a header, and @notes stays prose.
*//

---
model: gpt-6-luna
---

const total: number = 1; // --- not a fence

---
mode: agent
restrict: { fs: ./out }

Call @fib with 10 ->[Int] @fib10, update ->[List(Str)] @=names and mail user@example.com
Use a --- b and @@handle; model: is prose here
---

if (total > 0) {
    ---
    outputVar: =summary
    outputType: Str

    Summarize @notes.total
    ---
}
const text = \`
---
model: x
\`;
`);
show("---\nmode: codegen\n\nSlug of a title -> @slugify(text: string): string\n---\n");
console.log(hljs.listLanguages());
