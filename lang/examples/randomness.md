---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Randomness Controls

This document shows how to limit randomness in LLM prompts with `ask` sampling options.
Sampling is best-effort and does not guarantee identical responses.

```js
const sampling = { seed: 13, temperature: 0, topP: 0.0001, tokens: 1024 };
const prompt = '<most-frequent>give a recipe for an apple pie</most-frequent>';

const recipe1 = await ask(prompt, sampling);
const recipe2 = await ask(prompt, sampling);

const similar = await ask(`Is ${recipe1} and ${recipe2} semantically similar at least in 95%?`, { schema: bool });
if (!similar) fail('Not similar');
success('It works');
```
