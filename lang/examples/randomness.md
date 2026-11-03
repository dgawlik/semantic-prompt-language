---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Randomness Controls

This document shows how to limit randomness in LLM prompts and compare their semantic similarity.
Sampling is best-effort; the evaluation uses an additional model call rather than exact equality.

```spl
let recipe1 = randomness(seed=13, temperature=0.0, top_p=1.0) \
                ask 'a recipe for an apple pie';

let recipe2 = randomness(seed=13, temperature=0.0, top_p=1.0) \
                ask 'a recipe for an apple pie';
eval(expected=recipe1, actual=recipe2, cutoff=0.9)

success 'The recipes are at least 90% semantically similar'
```