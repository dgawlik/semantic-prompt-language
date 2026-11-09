---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Randomness Controls

This document shows how to limit randomness in LLM prompts with `ask` sampling modifiers.
Sampling is best-effort and does not guarantee identical responses.

```spl
let recipe1 = ask(seed=13, temperature=0.0, top_p=0.0001, tokens=1024) \
                '<most-frequent>give a recipe for an apple pie</most-frequent>';

let recipe2 = ask(seed=13, temperature=0.0, top_p=0.0001, tokens=1024) \
                '<most-frequent>give a recipe for an apple pie</most-frequent>';

if ask(schema=bool) 'Is {recipe1} and {recipe2} semantically similar at least in 95%?':
    success 'It works'
else:
    fail 'Not similar'
```