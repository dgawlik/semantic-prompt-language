---
extension: 'semantic-prompt-language'
version: 1
model: 'gpt-6-luna'
---

# Types 

This sample shows how to use opt-in types.

```spl
type FloatOrInt = float | int [description = 'Either float or int']

let numbers: list[FloatOrInt] = []

for i in range(4):
    let num = ask(tokens=128, schema=FloatOrInt) 'Sample number'
    numbers.append(num)

for n in numbers:
    if isinstance(n, int):
        log('Integer: {n}')
    else:
        log('Float: {n}')
```

```spl
class Person:
    firstName: str 
    lastName: str 
    age: int 

    def toString():
        return '{self.firstName} {self.lastName} at age {self.age}'

let result = ask(schema=struct(Person)) 'Sample person JSON with firstName, lastName and int age fields'

let person: Person = validate(result, Person)

success person.toString()
```