---
extension: 'semantic-prompt-language'
version: 1
---

# Enums and structs

```js
const Greeting = enumOf('hello', 'world');

// Greeting.parse('hi') would fail: expected "hello" | "world", got "hi"
const greeting = Greeting.parse('hello');
log(greeting);

const Test = struct('Test', {
    num: int,
    desc: str,
});

const test = Test.parse({ num: 1, desc: 'hi' });
log(test);

assert(Test.is({ num: 1, desc: 'hi' }), 'matching data satisfies the struct');
assert(!Test.is({ num: 1 }), 'every field is required');
assert(!Test.is({ num: 1, desc: 'hi', extra: true }), 'extra fields are rejected');
success(test);
```
