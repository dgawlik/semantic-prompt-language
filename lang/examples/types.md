---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Types

This sample shows how to describe model output with types.

```js
const FloatOrInt = union(float, int).annotate({ description: 'Either float or int' });

const numbers = [];
for (let i = 0; i < 4; i++) {
    numbers.push(await ask('Sample number', { tokens: 128, schema: FloatOrInt }));
}

for (const n of numbers) log(Number.isInteger(n) ? `Integer: ${n}` : `Float: ${n}`);
```

```js
const Person = struct('Person', {
    firstName: str,
    lastName: str,
    age: int.annotate({ desc: 'Age in years' }),
}).methods({
    toString() { return `${this.firstName} ${this.lastName} at age ${this.age}`; },
});

const person = await ask('Sample person JSON with firstName, lastName and int age fields', { schema: Person });

success(person.toString());
```
