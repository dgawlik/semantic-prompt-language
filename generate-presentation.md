---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6.1-terra'
---

# Generate Presentation

This workflow generates a six-slide introduction to SPL, including optional typed contracts.
Run it from the repository root. Generation uses an agent and may write presentation files;
`spl generate-presentation.md --check` checks the document without making model calls.

```spl
let slide1: str = '''
    Semantic Prompt Language is a Python-like language with LLM calls built in;
    mix exact code and natural-language steps in executable Markdown;
    distinguish deterministic checks from probabilistic model output
'''

let slide2: str = '''
    Getting started ->
    1. installation from npm
    2. API-key login and setting up VS Code
    3. running lang/examples/basics.md; run lang/examples/typed-data.md without a model
'''

let slide3: str = '''
    Blocks and code fences -> explain blockquote agent tools and shared variables;
    show colon blocks with exactly four spaces, object: dictionaries, and a compact exact-code example
'''

let slide4: str = '''
    Typed contracts -> primitive annotations, enums, exact structs, list[T], unions and type aliases;
    show type Money = int with integer-cent arithmetic and ask(schema=Invoice);
    distinguish structural data from hydratable class instances and object(instance) projection;
    metadata is model advice, assertions check business rules, annotations do not choose ask schemas
'''

let slide5: str = '''
    Checkpoints, replay and human input -> record responses with --trace, replay them with --replay;
    human input in the terminal or via repeated --human flags;
    explicit --checkpoint/--resume for automation, not an automatic snapshot of external files
'''

let slide6: str = '''
    Restrictions and MCP -> enforce and forbid are prompt guidance, restrict is runtime enforcement;
    show filesystem, command and MCP tool restrictions; restrictions are not an OS sandbox
'''

enforce 'Use modern-web-standards skill':
    forbid 'Hallucinating':
        agent '''

            Read the current README, docs-template guides and runnable examples before writing.
            Create a beautiful presentation of this repo for new starters: exactly 6 slides in HTML
            and a matching 6-page PDF. Use valid SPL examples and explain implemented features only.

            Slide1 - {slide1}
            Slide2 - {slide2}
            Slide3 - {slide3}
            Slide4 - {slide4}
            Slide5 - {slide5}
            Slide6 - {slide6}

            Save to folder presentations
'''
```