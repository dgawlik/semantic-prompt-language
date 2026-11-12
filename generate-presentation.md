---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6.1-terra'
---

# Generate Presentation

This workflow generates a six-slide introduction to SPL, including the type builder.
Run it from the repository root. Generation uses an agent and may write presentation files;
`spl generate-presentation.md --check` checks the document without making model calls.

```js
const slide1 = `
    Semantic Prompt Language: executable Markdown workflows and a Node.js library for checked model calls;
    mix native JavaScript fences and natural-language blockquotes in one document;
    distinguish deterministic checks from probabilistic model output
`;

const slide2 = `
    Getting started ->
    1. installation from npm (Node.js 24.15 or newer)
    2. API-key login and setting up VS Code
    3. running lang/examples/basics.md; run lang/examples/typed-data.md without a model
`;

const slide3 = `
    Fences and blockquotes -> js fences are native JavaScript with the library already imported and one shared scope;
    explain blockquote agent tools, @name markers and shared variables;
    show top-level await, an import of a node: module and a compact exact-code example
`;

const slide4 = `
    Types -> the schema builder: enumOf, struct, list, union, nullable, typedef and class types with methods;
    show typedef('Money', int) with integer-cent arithmetic and ask(prompt, { schema: Invoice });
    parse returns plain JavaScript objects or class instances;
    annotations are model advice, assertions check business rules
`;

const slide5 = `
    Append-only traces and human input -> record a run with --trace run.jsonl;
    human input in the terminal or via repeated --human flags;
    reuse the same --trace path to resume or replay deterministically, choose another file to restart
`;

const slide6 = `
    Restrictions and MCP -> enforce and forbid are prompt guidance, restrict is runtime enforcement;
    show filesystem, command and MCP tool restrictions; restrictions cover library tools and agents,
    not Node.js APIs called directly, and are not an OS sandbox
`;

await enforce('Use modern-web-standards skill', () => forbid('Hallucinating', () => agent(`
    Read the current README, docs-template guides and runnable examples before writing.
    Create a beautiful presentation of this repo for new starters: exactly 6 slides in HTML
    and a matching 6-page PDF. Use valid SPL examples and explain implemented features only.

    Slide1 - ${slide1}
    Slide2 - ${slide2}
    Slide3 - ${slide3}
    Slide4 - ${slide4}
    Slide5 - ${slide5}
    Slide6 - ${slide6}

    Save to folder presentations
`)));
```
