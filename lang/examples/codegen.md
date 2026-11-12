---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Generate a function, then use it

`@CODEGEN` asks the model for JavaScript functions and defines them in the shared scope.
With `--trace`, the code is saved next to this file as `codegen.sieve.js` and reused on later runs.

    spl examples/codegen.md --trace sieve.jsonl

> @CODEGEN 'Generate sieve(number) sieve of eratosthenes function that returns primes until given number'

```js
log(sieve(100));

const slugify = await codegen('slugify(title): lowercase, trim, and replace runs of non-alphanumeric characters with single dashes');
success(slugify('  Hello, Generated World!  '));
```
