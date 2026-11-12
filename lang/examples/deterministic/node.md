---
extension: 'semantic-prompt-language'
version: 1
---

# Plain JavaScript and the Node.js standard library

Fences are native JavaScript: top-level `await`, imports and every Node.js built-in work as usual.

```js
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

function fib(n) {
    return n < 2 ? 1 : fib(n - 1) + fib(n - 2);
}

const evens = Array.from({ length: 5 }, (_, index) => index * 2);
for (const [index, n] of evens.entries()) log(`${index} = ${n}`);

await sleep(10);
const digest = createHash('sha256').update(String(fib(10))).digest('hex').slice(0, 8);
success({ fib: fib(10), evens, digest, file: path.basename(import.meta.filename) });
```
