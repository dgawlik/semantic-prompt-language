---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Environment variables and arguments

Agents read environment variables one at a time with `@env.NAME`; code reads `env` and `args` directly.

    lhs=2 rhs=40 spl examples/env.md --arg first --arg second

> Calculate the sum of @env.lhs and @env.rhs save to @s

```js
const [first, second] = args;

log(first, second);
log(`HOME is ${env.HOME ?? env.USERPROFILE}`);
```

> Return @success with @s
