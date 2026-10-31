---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6.1-terra'
---

# Generate Presentation

This example presents how to use the tool to generate presentation for itself.

```spl
let slide1 = '''
    Semantic Prompt Language is a python language with LLM calls built in; 
    forget callback hell of most agentic frameworks;
    run automations with high reliablity
''';

let slide2 = '''
    Getting started -> 
    1. installation from npm
    2. setting up vscode
    3. running examples/basics.md
'''

let slide3 = '''
    Blocks and code fences -> explanation what blockquote does the internal tool it uses;
    most compact and descriptive example of deterministic syntax
'''

let slide4 = '''
    Checkpoints, replay and human input -> when program crashes rereun it with llms responses
    saved; human input with in-terminal input and via flags
'''

let slide5 = '''
    Restrictions and mcps; how restrictions work, enforce and forbid -> soft, restriction -> hard, 
    way to invoke mcp
'''

enforce 'Use modern-web-standards skill':
    forbid 'Hallucinating':
        agent '''

            Create beautiful presentation of this repo for new-starters. Limit output to 5 pages html and pdf.

            Slide1 - {slide1}
            Slide2 - {slide2}
            Slide3 - {slide3}
            Slide4 - {slide4}
            Slide5 - {slide5}

            Save to folder presentations
'''
```