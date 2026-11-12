---
extension: 'semantic-prompt-language'
version: 1
---

# Import your own modules and the Node.js standard library

Imports resolve against the working directory, so run this from the `lang` folder:

    spl examples/imports/run.md

```js
import os from 'node:os';
import { fib as f, factorial } from './examples/imports/functions.js';

log(f(10));
log(factorial(10));
success({ fib: f(10), factorial: factorial(10), platform: os.platform() });
```
