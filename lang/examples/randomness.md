---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Randomness Controls

This document shows how to limit randomness in LLM prompts and approximate their text similarity.
Sampling is best-effort; evaluation uses local TF-IDF cosine scoring with no additional model call.

```spl
let recipe1 = randomness(seed=13, temperature=0.0, top_p=1.0) \
                ask 'a recipe for an apple pie';

let recipe2 = randomness(seed=13, temperature=0.0, top_p=1.0) \
                ask 'a recipe for an apple pie';
eval(expected=recipe1, actual=recipe2, cutoff=0.9)

success 'The recipes have a TF-IDF cosine similarity of at least 0.9'
```