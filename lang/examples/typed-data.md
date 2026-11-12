---
extension: 'semantic-prompt-language'
version: 1
---

# Typed data without a model

Types are built with library functions. This workflow uses no model calls or credentials:

    spl examples/typed-data.md

It covers primitives, named aliases, enums, exact structs, nullable fields, unions,
annotations, classes with methods, validation and JSON Schema output.
With a model, `ask(prompt, { schema: Person })` parses the answer into the same objects.
Annotations are advice for the model; use assertions for business rules.

```js
const Color = enumOf('red', 'green', 'blue');
const Palette = typedef('Palette', list(Color));
const Money = typedef('Money', int, { minimum: 0, desc: 'Amount in cents' });

const Address = struct('Address', {
    city: str,
    postalCode: nullable(str),
});

const Person = struct('Person', {
    name: str.describe('Full name'),
    favorite: Color,
    address: Address,
}).methods({
    greeting() { return `Hello ${this.name}`; },
});

// Plain JSON in, checked JavaScript objects out: nothing is coerced or filled in.
const colors = Palette.parse(['blue', 'green']);
const address = validate(JSON.parse('{"city":"London","postalCode":null}'), Address);
const person = Person.parse({ name: 'Ada', favorite: colors[0], address });

assert(person.greeting() === 'Hello Ada', 'parsed objects carry their methods');
assert(Person.is(person) && !Person.is({ name: 'Ada' }), 'is() tests without throwing');
assert(Money.parse(1250) * 2 === 2500, 'aliases are transparent');
assert(Money.parse(-1) === -1, 'annotations such as minimum are advice, not validation');

const Id = union(int, str);
assert(Id.is(7) && Id.is('seven') && !Id.is(null), 'unions accept any member');

let problem = '';
try {
    Person.parse({ name: 'Ada', favorite: 'purple', address });
} catch (error) {
    problem = error.reason;
}
assert(problem === '$.favorite: expected "red" | "green" | "blue", got "purple"', 'errors name the field');

// The JSON Schema a model would receive, including the annotations.
const schema = Person.schema();
assert(schema.properties.name.description === 'Full name', 'descriptions reach the schema');

// Class instances serialize like plain data; the plain view drops the methods again.
const snapshot = Person.data.parse(JSON.parse(JSON.stringify(person)));
snapshot.address.city = 'Paris';
assert(person.address.city === 'London', 'parsing copies its input');

log(person.greeting(), Money.name, Money.annotations);
success(person);
```
